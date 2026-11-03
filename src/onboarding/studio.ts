/**
 * The Onboarding Studio: a custom editor on the `onboard.yaml` of an onboarding workspace.  It renders what
 * `onboard status --json` prints and runs every action as an `onboard` command in a terminal, so nothing
 * happens that the user could not type.
 */
import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
    commands,
    CustomTextEditorProvider,
    Disposable,
    ExtensionContext,
    RelativePattern,
    Terminal,
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
    | { type: "open"; path: string };

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

function debounce(f: () => void, ms: number): () => void {
    let timer: NodeJS.Timeout | undefined;
    return () => {
        clearTimeout(timer);
        timer = setTimeout(f, ms);
    };
}

class OnboardingStudioProvider implements CustomTextEditorProvider {
    private readonly terminals = new Map<string, Terminal>();

    constructor(private readonly context: ExtensionContext) {
        context.subscriptions.push(window.onDidCloseTerminal((t) => {
            for (const [key, terminal] of this.terminals) {
                if (terminal === t) {
                    this.terminals.delete(key);
                }
            }
        }));
    }

    async resolveCustomTextEditor(document: TextDocument, panel: WebviewPanel): Promise<void> {
        const webview = panel.webview;
        const workspaceDir = path.dirname(document.uri.fsPath);
        const outDir = Uri.joinPath(this.context.extensionUri, "out");
        webview.options = { enableScripts: true, localResourceRoots: [outDir] };
        webview.html = this.html(webview.asWebviewUri(Uri.joinPath(outDir, "onboarding.js")).toString(), webview.cspSource);

        let loading = false;
        let again = false;
        const load = async () => {
            if (loading) {
                again = true;
                return;
            }
            loading = true;
            try {
                const engine = findEngine(workspaceDir);
                if (engine === null) {
                    await webview.postMessage({
                        type: "error",
                        message: `No .venv with the onboarding engine above ${workspaceDir}. Set inmanta.onboarding.python to the python that has it.`,
                    });
                    return;
                }
                const command = [engine.python, ...engine.prefix].map(quote).join(" ");
                try {
                    const stdout = await new Promise<string>((resolve, reject) => {
                        execFile(engine.python, [...engine.prefix, "status", "--json"], { cwd: engine.cwd, maxBuffer: 512 * 1024 * 1024 }, (error, out, err) =>
                            error ? reject(new Error(err.trim() || error.message)) : resolve(out),
                        );
                    });
                    await webview.postMessage({ type: "load", data: JSON.parse(stdout), command, cwd: engine.cwd });
                } catch (e) {
                    await webview.postMessage({ type: "error", message: `${command} status --json failed:\n${e instanceof Error ? e.message : String(e)}` });
                }
            } finally {
                loading = false;
                if (again) {
                    again = false;
                    void load();
                }
            }
        };
        const scheduleLoad = debounce(() => void load(), 400);

        // Every command writes into the workspace: reload on any change there, but not on the raw sources
        const watcher = workspace.createFileSystemWatcher(new RelativePattern(workspaceDir, "{onboard.yaml,candidates/**,observations/*,rules/**,sources/*/manifest.yaml}"));
        const subscriptions: Disposable[] = [
            watcher,
            watcher.onDidChange(scheduleLoad),
            watcher.onDidCreate(scheduleLoad),
            watcher.onDidDelete(scheduleLoad),
            webview.onDidReceiveMessage((message: WebviewMessage) => this.receive(message, workspaceDir, load)),
        ];
        panel.onDidDispose(() => subscriptions.forEach((s) => s.dispose()));
    }

    private async receive(message: WebviewMessage, workspaceDir: string, load: () => Promise<void>): Promise<void> {
        switch (message.type) {
            case "ready":
            case "refresh":
                await load();
                return;
            case "run":
                this.run(workspaceDir, message.args);
                return;
            case "open": {
                const uri = Uri.file(path.join(workspaceDir, message.path));
                await window.showTextDocument(uri, { viewColumn: ViewColumn.Beside, preview: true });
                return;
            }
        }
    }

    /** Type the command in the terminal of the workspace: the user sees it, its output and can rerun it */
    private run(workspaceDir: string, args: string[]): void {
        const engine = findEngine(workspaceDir);
        if (engine === null) {
            void window.showErrorMessage("Onboarding Studio: no python with the onboarding engine, set inmanta.onboarding.python");
            return;
        }
        let terminal = this.terminals.get(workspaceDir);
        if (terminal === undefined) {
            const editor = workspace.getConfiguration("inmanta.onboarding").get<string>("editor");
            terminal = window.createTerminal({
                name: `onboard ${path.basename(workspaceDir)}`,
                cwd: engine.cwd,
                // `review edit` and `rules diff` open their draft here; closing the tab without saving aborts
                env: editor ? { VISUAL: editor } : undefined,
            });
            this.terminals.set(workspaceDir, terminal);
        }
        terminal.show(true);
        terminal.sendText([engine.python, ...engine.prefix, ...args].map(quote).join(" "));
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
