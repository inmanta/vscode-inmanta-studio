/**
 * The Onboarding Studio: a custom editor on the `onboard.yaml` of an onboarding workspace.  It talks to `onboard serve`,
 * the engine that keeps the workspace up to date and pushes what changed.  Every action is an `onboard` command as the
 * CLI takes it, so nothing happens that the user could not type; the activity shows each one.
 */
import { ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import {
    commands,
    CustomTextEditorProvider,
    ExtensionContext,
    OutputChannel,
    TabInputText,
    TextDocument,
    Uri,
    ViewColumn,
    WebviewPanel,
    window,
    workspace,
} from "vscode";

export const VIEW_TYPE = "inmanta.onboardingStudio";

/** Messages sent by the webview */
export type WebviewMessage =
    | { type: "ready" }
    | { type: "refresh" }
    | { type: "run"; args: string[] }
    | { type: "step"; step: string }
    | { type: "open"; path: string };

/** The commands with a draft to edit: the draft opens in an editor tab, saving it passes it back with `--from` */
const EDITOR_COMMANDS = [["review", "edit"], ["rules", "diff"]];

/** How to run `onboard` for a workspace: the python, the directory to run in and the command as typed there */
interface Engine {
    python: string;
    cwd: string;
    prefix: string[];
}

function exists(file: string): boolean {
    try {
        return fs.statSync(file).isFile();
    } catch (_e) {
        return false;
    }
}

/** The python of `inmanta.onboarding.python`, or the first `.venv` up from the workspace that has the engine */
function findEngine(workspaceDir: string): Engine | null {
    const configured = workspace.getConfiguration("inmanta.onboarding").get<string>("python");
    const venvPython = process.platform === "win32" ? path.join(".venv", "Scripts", "python.exe") : path.join(".venv", "bin", "python");
    let cwd: string | null = null;
    let python = configured || "";
    if (python) {
        cwd = path.dirname(workspaceDir);
    } else {
        for (let dir = workspaceDir; ; dir = path.dirname(dir)) {
            if (exists(path.join(dir, venvPython))) {
                cwd = dir;
                python = venvPython;
                break;
            }
            if (path.dirname(dir) === dir) {
                break;
            }
        }
    }
    if (cwd === null) {
        return null;
    }
    const relative = path.relative(cwd, workspaceDir) || ".";
    return { python, cwd, prefix: ["-m", "onboard", "--workspace", relative] };
}

function quote(arg: string): string {
    return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** A message of `onboard serve`: an event, or the reply to a request */
interface EngineMessage {
    event?: "snapshot" | "steps" | "activity" | "error";
    data?: unknown;
    id?: number;
    result?: { ok: boolean; output: string; command?: string };
    error?: string;
}

/**
 * The `onboard serve` of one workspace, shared by its panels.  It restarts when it stops, unless it keeps stopping
 * right after it started: then the panels show why.
 */
class EngineProcess {
    private process: ChildProcess | null = null;
    private nextId = 1;
    private readonly pending = new Map<number, (message: EngineMessage) => void>();
    private readonly listeners = new Set<(message: EngineMessage | { event: "stopped"; data: string }) => void>();
    private quickExits = 0;
    private stderr: string[] = [];
    private disposed = false;
    /** The last snapshot and steps: a panel that opens later gets them right away */
    private readonly last = new Map<string, EngineMessage>();

    constructor(private readonly workspaceDir: string, private readonly output: OutputChannel) {}

    listen(listener: (message: EngineMessage | { event: "stopped"; data: string }) => void): () => void {
        this.listeners.add(listener);
        this.last.forEach((m) => listener(m));
        this.start();
        return () => {
            this.listeners.delete(listener);
            if (this.listeners.size === 0) {
                this.stop();
            }
        };
    }

    private broadcast(message: EngineMessage | { event: "stopped"; data: string }): void {
        this.listeners.forEach((l) => l(message));
    }

    private start(): void {
        if (this.process || this.disposed) {
            return;
        }
        const engine = findEngine(this.workspaceDir);
        if (engine === null) {
            this.broadcast({ event: "stopped", data: `No .venv with the onboarding engine above ${this.workspaceDir}. Set inmanta.onboarding.python to the python that has it.` });
            return;
        }
        const started = Date.now();
        const child = spawn(engine.python, [...engine.prefix, "serve"], { cwd: engine.cwd, stdio: ["pipe", "pipe", "pipe"] });
        this.process = child;
        this.stderr = [];
        this.output.appendLine(`started: ${[engine.python, ...engine.prefix, "serve"].map(quote).join(" ")} in ${engine.cwd}`);
        readline.createInterface({ input: child.stdout! }).on("line", (line) => this.receive(line));
        readline.createInterface({ input: child.stderr! }).on("line", (line) => {
            this.output.appendLine(line);
            this.stderr = [...this.stderr.slice(-40), line];
        });
        child.on("error", (e) => this.output.appendLine(`engine: ${e.message}`));
        child.on("exit", (code) => {
            this.process = null;
            this.pending.forEach((resolve) => resolve({ result: { ok: false, output: "the engine stopped" } }));
            this.pending.clear();
            if (this.disposed || this.listeners.size === 0) {
                return;
            }
            this.quickExits = Date.now() - started < 10_000 ? this.quickExits + 1 : 0;
            const why = `onboard serve stopped (exit ${code}):\n${this.stderr.slice(-15).join("\n")}`;
            this.broadcast({ event: "stopped", data: this.quickExits >= 3 ? `${why}\n\nNot restarted: it stopped ${this.quickExits} times right after it started. Refresh to try again.` : why });
            if (this.quickExits < 3) {
                setTimeout(() => this.start(), 2000);
            }
        });
    }

    private stop(): void {
        this.process?.stdin?.end();
        this.process = null;
    }

    dispose(): void {
        this.disposed = true;
        this.stop();
    }

    /** Start it again after it gave up, e.g. once the python or the workspace is fixed */
    restart(): void {
        this.quickExits = 0;
        this.start();
    }

    private receive(line: string): void {
        let message: EngineMessage;
        try {
            message = JSON.parse(line) as EngineMessage;
        } catch (_e) {
            this.output.appendLine(`not json: ${line}`);
            return;
        }
        if (message.id !== undefined) {
            this.pending.get(message.id)?.(message);
            this.pending.delete(message.id);
            return;
        }
        if (message.event === "snapshot" || message.event === "steps") {
            this.last.set(message.event, message);
        }
        this.broadcast(message);
    }

    request(method: string, params: object): Promise<EngineMessage> {
        this.start();
        const child = this.process;
        if (!child?.stdin) {
            return Promise.resolve({ error: "the engine is not running" });
        }
        const id = this.nextId++;
        return new Promise((resolve) => {
            this.pending.set(id, resolve);
            child.stdin!.write(JSON.stringify({ id, method, params }) + "\n");
        });
    }
}

class OnboardingStudioProvider implements CustomTextEditorProvider {
    /** The open drafts by file: what to stop when the draft is taken or its tab closes */
    private readonly drafts = new Map<string, () => void>();
    private readonly engines = new Map<string, EngineProcess>();
    private readonly output = window.createOutputChannel("Inmanta Onboarding");

    constructor(private readonly context: ExtensionContext) {
        context.subscriptions.push(this.output, { dispose: () => this.engines.forEach((e) => e.dispose()) });
        context.subscriptions.push({ dispose: () => [...this.drafts.values()].forEach((stop) => stop()) });
    }

    async resolveCustomTextEditor(document: TextDocument, panel: WebviewPanel): Promise<void> {
        const webview = panel.webview;
        const workspaceDir = path.dirname(document.uri.fsPath);
        const outDir = Uri.joinPath(this.context.extensionUri, "out");
        webview.options = { enableScripts: true, localResourceRoots: [outDir] };
        webview.html = this.html(webview.asWebviewUri(Uri.joinPath(outDir, "onboarding.js")).toString(), webview.cspSource);

        const engine = this.engine(workspaceDir);
        const command = () => {
            const found = findEngine(workspaceDir);
            return found ? [found.python, ...found.prefix].map(quote).join(" ") : "onboard";
        };
        const unlisten = engine.listen((message) => {
            switch (message.event) {
                case "snapshot":
                    void webview.postMessage({ type: "load", data: message.data, command: command() });
                    return;
                case "steps":
                    void webview.postMessage({ type: "steps", steps: message.data });
                    return;
                case "activity":
                    void webview.postMessage({ type: "activity", activity: message.data });
                    return;
                case "error":
                case "stopped":
                    void webview.postMessage({ type: "error", message: String(message.data) });
                    return;
            }
        });
        const subscription = webview.onDidReceiveMessage((message: WebviewMessage) => this.receive(message, workspaceDir, webview, engine));
        panel.onDidDispose(() => {
            unlisten();
            subscription.dispose();
        });
    }

    private engine(workspaceDir: string): EngineProcess {
        let engine = this.engines.get(workspaceDir);
        if (engine === undefined) {
            engine = new EngineProcess(workspaceDir, this.output);
            this.engines.set(workspaceDir, engine);
        }
        return engine;
    }

    private async receive(message: WebviewMessage, workspaceDir: string, webview: WebviewPanel["webview"], engine: EngineProcess): Promise<void> {
        switch (message.type) {
            case "ready":
            case "refresh":
                engine.restart();
                await engine.request("snapshot", {});
                return;
            case "run": {
                if (EDITOR_COMMANDS.some(([a, b]) => message.args[0] === a && message.args[1] === b)) {
                    await this.draft(message.args, webview, engine);
                    return;
                }
                const reply = await engine.request("run", { args: message.args });
                await webview.postMessage({ type: "reply", args: message.args, ok: reply.result?.ok ?? false, output: reply.result?.output ?? reply.error ?? "" });
                return;
            }
            case "step": {
                const reply = await engine.request("refresh", { step: message.step });
                await webview.postMessage({ type: "reply", args: message.step.split(" "), ok: reply.result?.ok ?? false, output: reply.result?.output ?? reply.error ?? "" });
                return;
            }
            case "open": {
                const uri = Uri.file(path.join(workspaceDir, message.path));
                await window.showTextDocument(uri, { viewColumn: ViewColumn.Beside, preview: true });
                return;
            }
        }
    }

    /** Open the draft of an editor command in a tab; each save passes it to the engine, until it takes it */
    private async draft(args: string[], webview: WebviewPanel["webview"], engine: EngineProcess): Promise<void> {
        const made = await engine.request("run", { args: [...args, "--draft"] });
        if (!made.result?.ok) {
            await webview.postMessage({ type: "reply", args, ok: false, output: made.result?.output ?? made.error ?? "" });
            return;
        }
        await this.reopen(made.result.output.trim().split("\n").pop() ?? "", args, webview, engine);
    }

    /** Show a draft file and pass each save to the engine with `--from`, until it takes it */
    private async reopen(file: string, args: string[], webview: WebviewPanel["webview"], engine: EngineProcess): Promise<void> {
        this.drafts.get(file)?.();
        const document = await workspace.openTextDocument(Uri.file(file));
        await window.showTextDocument(document, { viewColumn: ViewColumn.Beside, preview: false });
        await webview.postMessage({ type: "reply", args, ok: true, output: "the draft is open: save it to apply, close it without saving to abort" });
        let refused = false;
        const tabs = () => window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof TabInputText && t.input.uri.fsPath === document.uri.fsPath);
        const saved = workspace.onDidSaveTextDocument(async (d) => {
            if (d.uri.fsPath !== document.uri.fsPath) {
                return;
            }
            const reply = await engine.request("run", { args: [...args, "--from", file] });
            const ok = reply.result?.ok ?? false;
            await webview.postMessage({ type: "reply", args, ok, output: reply.result?.output ?? reply.error ?? "" });
            if (ok) {
                stop();
                await window.tabGroups.close(tabs());
            }
            // a refusal is written on top of the draft as `# error:` lines: the tab reloads it, fix and save again
            refused = !ok;
        });
        const closed = window.tabGroups.onDidChangeTabs(() => {
            if (tabs().length > 0) {
                return;
            }
            stop();
            if (!refused) {
                fs.rmSync(file, { force: true }); // closed without saving: aborted
                return;
            }
            // saved but refused: the work stays, a new draft of the same changes overwrites it
            void window.showWarningMessage("Onboarding Studio: the draft was not taken, it is kept until the next draft.", "Reopen").then((choice) => {
                if (choice === "Reopen") {
                    void this.reopen(file, args, webview, engine);
                }
            });
        });
        const stop = (): void => {
            saved.dispose();
            closed.dispose();
            this.drafts.delete(file);
        };
        this.drafts.set(file, stop);
    }

    private html(script: string, cspSource: string): string {
        const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${cspSource} data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Onboarding Studio</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
    }
}

export function registerOnboardingStudio(context: ExtensionContext): void {
    context.subscriptions.push(
        window.registerCustomEditorProvider(VIEW_TYPE, new OnboardingStudioProvider(context), {
            webviewOptions: { retainContextWhenHidden: true },
        }),
        commands.registerCommand("inmanta.openOnboardingStudio", async (uri?: Uri) => {
            const target = uri ?? window.activeTextEditor?.document.uri;
            if (target === undefined || path.basename(target.path) !== "onboard.yaml") {
                void window.showInformationMessage("Open the onboard.yaml of an onboarding workspace first");
                return;
            }
            await commands.executeCommand("vscode.openWith", target, VIEW_TYPE);
        }),
    );
}
