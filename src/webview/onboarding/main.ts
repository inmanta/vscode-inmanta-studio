/**
 * The Onboarding Studio webview.  It shows the snapshot of `onboard status --json` and turns every action into an
 * `onboard` command that the extension types in a terminal: the studio suggests, the user decides.
 */
import { add, Child, clear, h } from "../dom";
import { bindSplitter } from "../splitter";
import css from "../studio.css";
import onboardingCss from "./onboarding.css";
import { Candidate, CatalogAttribute, Change, Finding, Snapshot } from "./types";

interface VsCodeApi {
    postMessage(message: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();

type View = "pipeline" | "candidates" | "rules";

interface Ui {
    view: View;
    stage: string;
    entity: string;
    search: string;
    selected: string | null;
    leftWidth?: number;
    rightWidth?: number;
}

const saved = (vscode.getState() ?? {}) as Partial<Ui>;
const ui: Ui = { view: "candidates", stage: "all", entity: "all", search: "", selected: null, ...saved };

let data: Snapshot | null = null;
let command = "onboard";
let error: string | null = null;
/** Not persisted: the candidates checked for a bulk command, the changes picked for a diff rule, values being typed */
const checked = new Set<string>();
const picked = new Set<number>();
const drafts = new Map<string, string>();
/** `key|attribute` of the attribute rows with their set form open */
const editing = new Set<string>();
let reason = "";

function persist(): void {
    vscode.setState(ui);
}

function post(message: unknown): void {
    vscode.postMessage(message);
}

// ---------- layout ----------

const style = document.createElement("style");
style.textContent = `${css}\n${onboardingCss}`;
document.head.appendChild(style);

const app = document.getElementById("app")!;
app.classList.add("onboarding");
const toolbar = h("div", { class: "toolbar" });
const left = h("aside", { class: "panel left" });
const content = h("main", { class: "panel content" });
const inspector = h("aside", { class: "panel inspector" });
const footer = h("div", { class: "problems" });
const leftSplit = h("div", { class: "splitter left-split", title: "Drag to resize, double click to reset" });
const rightSplit = h("div", { class: "splitter right-split", title: "Drag to resize, double click to reset" });
const main = h("div", { class: "main" }, left, content, inspector, leftSplit, rightSplit);
app.append(toolbar, main, footer);

function applyWidths(): void {
    for (const [name, width] of [["--left-w", ui.leftWidth], ["--right-w", ui.rightWidth]] as const) {
        if (width === undefined) {
            app.style.removeProperty(name);
        } else {
            app.style.setProperty(name, `${width}px`);
        }
    }
}
for (const [splitter, side] of [[leftSplit, "leftWidth"], [rightSplit, "rightWidth"]] as const) {
    bindSplitter(splitter, main, side === "leftWidth" ? "left" : "right", (width) => {
        ui[side] = width;
        applyWidths();
    }, persist);
}
applyWidths();

// ---------- helpers ----------

/** The stages of the flow; an instance still in an onboarding state shows its state and counts as onboarding */
const FLOW = ["blocked", "review", "ready", "accepted", "onboarding", "onboarded", "rejected", "deleting", "deleted"];
const STAGE_CLASS: Record<string, string> = {
    blocked: "l-danger", review: "l-warning", ready: "l-info", accepted: "l-info", onboarding: "l-warning", onboarded: "l-success", rejected: "l-none", deleting: "l-warning", deleted: "l-none",
};
const LEVEL_CLASS: Record<string, string> = { blocker: "l-danger", conflict: "l-warning", input: "l-info" };
const CLASS_CLASS: Record<string, string> = { safe: "l-success", intent: "l-info", source: "l-warning", model: "l-warning", unsafe: "l-danger", unclassified: "l-danger" };

function flowStage(c: Candidate): string {
    return FLOW.includes(c.stage) ? c.stage : "onboarding";
}

function badge(text: string, cls: string | undefined, title?: string): HTMLElement {
    return h("span", { class: `badge ${cls ?? "l-none"}`, title }, text);
}

function section(title: string, ...children: Child[]): HTMLElement {
    return h("section", null, h("h3", null, title), ...children);
}

/** A value as the yaml `review set` reads: plain when it is a simple string, else json, which is yaml too */
function yamlValue(value: unknown): string {
    if (typeof value === "string" && /^[\w./:@-][\w ./:@-]*$/.test(value) && !/^(true|false|null|yes|no|on|off|~|[-+]?[\d.]+)$/i.test(value)) {
        return value;
    }
    return JSON.stringify(value);
}

function short(value: unknown, max = 80): string {
    const text = value === undefined ? "-" : typeof value === "string" ? value : JSON.stringify(value);
    return text.length > max ? `${text.slice(0, max)}... (${text.length} chars)` : text;
}

function shellArg(arg: string): string {
    return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** The command as it shows in the studio: `onboard` and its arguments, the terminal shows the full line */
function commandText(args: string[]): string {
    return ["onboard", ...args].map(shellArg).join(" ");
}

function run(args: string[]): void {
    post({ type: "run", args });
}

/** A button that runs one command, with the command under its title; disabled with the reason why */
/** `uncheck`: the checked candidates the command takes, unchecked once it runs: they move to another stage */
function cmd(title: string, args: string[] | null, options: { why?: string | false; danger?: boolean; hint?: string; uncheck?: string[] } = {}): HTMLElement {
    const disabled = Boolean(options.why) || args === null;
    return h("button", {
        class: `cmd${options.danger ? " danger" : ""}`,
        disabled,
        title: options.hint ?? (args ? `Runs in the terminal: ${command} ${args.map(shellArg).join(" ")}` : undefined),
        onclick: () => args && runAndUncheck(args, options.uncheck ?? []),
    }, h("b", null, title), args ? h("code", null, `$ ${commandText(args)}`) : null, disabled && options.why ? h("span", { class: "why" }, options.why) : null);
}

function runAndUncheck(args: string[], keys: string[]): void {
    run(args);
    if (keys.length) {
        keys.forEach((k) => checked.delete(k));
        render();
    }
}

function openFile(file: string): void {
    post({ type: "open", path: file });
}

function fileButton(file: string, label = file.split("/").pop() ?? file): HTMLElement {
    return h("button", { class: "link mono", title: `Open ${file}`, onclick: () => openFile(file) }, label);
}

// ---------- render ----------

let rendered: { view: string; selected: string | null } | null = null;

/** Every change re-renders the panels: keep where each one is scrolled, the details only for the same candidate */
function render(): void {
    const same = rendered?.view === ui.view;
    const scrolls = [left, ...(same && rendered?.selected === ui.selected ? [content, inspector] : [])].map((p) => [p, p.scrollTop] as const);
    renderPanels();
    if (same) {
        scrolls.forEach(([p, top]) => (p.scrollTop = top));
    }
    rendered = { view: ui.view, selected: ui.selected };
}

function renderPanels(): void {
    app.dataset.view = ui.view;
    app.dataset.mode = ui.view === "candidates" ? "edit" : "view";
    renderToolbar();
    clear(left);
    clear(content);
    clear(inspector);
    clear(footer);
    if (error) {
        add(footer, h("pre", { class: "error mono" }, error));
    }
    if (data === null) {
        add(content, h("p", { class: "muted" }, error ? "The workspace can't be read." : "Reading the workspace..."));
        return;
    }
    for (const e of data.errors) {
        add(footer, h("div", { class: "warning" }, e));
    }
    footer.hidden = !error && data.errors.length === 0;
    if (ui.view === "pipeline") {
        renderPipeline(data);
    } else if (ui.view === "rules") {
        renderRules(data);
    } else {
        renderCandidates(data);
    }
}

function seg<T extends string>(options: [T, string][], value: T, onChange: (v: T) => void): HTMLElement {
    return h("div", { class: "seg" }, options.map(([v, label]) => h("button", { class: v === value ? "on" : "", onclick: () => onChange(v) }, label)));
}

function renderToolbar(): void {
    clear(toolbar);
    const orchestrator = data?.workspace.orchestrator;
    add(toolbar,
        h("b", null, "Onboarding Studio"),
        data ? h("span", { class: "mono" }, data.workspace.name) : null,
        seg<View>([["pipeline", "Pipeline"], ["candidates", "Candidates"], ["rules", "Rules"]], ui.view, (v) => {
            ui.view = v;
            persist();
            render();
        }),
        h("div", { class: "files" },
            orchestrator?.url ? h("span", { class: "muted", title: "orchestrator: in onboard.yaml, where apply, result and decide act" }, `${orchestrator.url} `, h("span", { class: "mono" }, orchestrator.environment ?? "")) : h("span", { class: "warning" }, "no orchestrator in onboard.yaml"),
            fileButton("onboard.yaml"),
            h("button", { title: "Read the workspace again (status --json)", onclick: () => post({ type: "refresh" }) }, "Refresh"),
        ),
    );
}

// ---------- pipeline ----------

function stageCounts(candidates: Candidate[]): Map<string, number> {
    const counts = new Map<string, number>(FLOW.map((s) => [s, 0]));
    candidates.forEach((c) => counts.set(flowStage(c), (counts.get(flowStage(c)) ?? 0) + 1));
    return counts;
}

function renderPipeline(d: Snapshot): void {
    const sources = h("table", { class: "table" },
        h("thead", null, h("tr", null, ["Source", "Plugin", "Latest folder", "Fetched", ""].map((t) => h("th", null, t)))),
        h("tbody", null, d.sources.map((s) => h("tr", null,
            h("td", { class: "mono" }, h("b", null, s.name)),
            h("td", { class: "mono" }, s.plugin),
            h("td", { class: "mono" }, s.latest ? `sources/${s.latest}/` : h("span", { class: "warning" }, "never fetched")),
            h("td", { class: "muted" }, s.fetched_at ?? "-"),
            h("td", null, h("button", { title: `$ ${commandText(["fetch", s.name])}`, onclick: () => run(["fetch", s.name]) }, "Fetch")),
        ))),
    );
    const observations = h("table", { class: "table" },
        h("thead", null, h("tr", null, ["Type", "Source", "Records"].map((t) => h("th", null, t)))),
        h("tbody", null, d.observations.map((o) => h("tr", null,
            h("td", { class: "mono" }, o.type),
            h("td", { class: "mono muted" }, o.source ?? "-"),
            h("td", { class: "num" }, o.count === null ? h("span", { class: "warning" }, "not built") : String(o.count)),
        ))),
    );
    add(content, statusSection(d),
        section("Sources", h("p", { class: "help" }, "What onboard.yaml declares, and the latest folder of each. A fetch writes a new dated folder, a second fetch on the same day replaces it."), sources),
        section("Observations", h("p", { class: "help" }, "Typed records from the latest sources, declared in rules/observations.yaml."), observations,
            h("div", { class: "actions" }, cmd("Build the observations", ["observe"]))),
        section("Candidates", h("p", { class: "help" }, "The identify rules turn observations into candidates with findings. The reviews stay."),
            h("div", { class: "actions" }, cmd("Identify", ["identify"]), cmd("Status", ["status"]))),
        section("Instances", h("p", { class: "help" }, "Read back the state, resources and diff of every applied candidate into result.yaml."),
            h("div", { class: "actions" }, cmd("Read back every instance", ["result"]), cmd("Changes of every instance", ["changes"]))),
    );
}

function statusSection(d: Snapshot): HTMLElement {
    const entities = [...new Set(d.candidates.map((c) => c.entity))].sort();
    const table = h("table", { class: "table status" },
        h("thead", null, h("tr", null, h("th", null, "entity"), FLOW.map((s) => h("th", { class: "num" }, s)), h("th", { class: "num" }, "total"))),
        h("tbody", null, entities.map((entity) => {
            const of = d.candidates.filter((c) => c.entity === entity);
            const counts = stageCounts(of);
            return h("tr", null, h("td", { class: "mono" }, entity), FLOW.map((s) => h("td", { class: "num" },
                counts.get(s) ? h("button", { class: "link", onclick: () => showStage(entity, s) }, String(counts.get(s))) : h("span", { class: "muted" }, "0"),
            )), h("td", { class: "num" }, String(of.length)));
        })),
    );
    return section("Status", entities.length ? table : h("p", { class: "muted" }, "No candidates yet: run identify."));
}

function showStage(entity: string, stage: string): void {
    Object.assign(ui, { view: "candidates", entity, stage });
    persist();
    render();
}

// ---------- rules ----------

function renderRules(d: Snapshot): void {
    const groups = new Map<string, string[]>();
    for (const file of d.rules) {
        const parts = file.split("/");
        const group = parts.length > 2 ? parts[1] : "rules";
        groups.set(group, [...(groups.get(group) ?? []), file]);
    }
    add(content, h("p", { class: "help" }, "The pack: what is specific to this customer and service. Every file is plain text in git; the engine checks the rules when a command loads them."));
    for (const [group, files] of groups) {
        add(content, section(group, h("ul", { class: "plain" }, files.map((f) => h("li", null, fileButton(f, f.replace(/^rules\//, "")))))));
    }
    add(inspector,
        section("Rerun", h("div", { class: "actions column" },
            cmd("Identify", ["identify"], { hint: "After an identify or observations rule changed" }),
            cmd("Changes", ["changes"], { hint: "After a diff rule changed: reclassifies result.yaml, talks to no orchestrator" }),
        )),
        section("Diff rules", h("p", { class: "help" }, "Write one from the changes of a candidate: pick the changes in its detail, then Write a diff rule.")),
    );
}

// ---------- candidates ----------

/** The candidates of the entity that match the search, in every stage: what the stage chips count */
function found(d: Snapshot): Candidate[] {
    const search = ui.search.toLowerCase();
    return d.candidates.filter((c) =>
        (ui.entity === "all" || c.entity === ui.entity) &&
        (!search || c.key.toLowerCase().includes(search) || c.findings.some((f) => f.state === "open" && `${f.attribute} ${f.message}`.toLowerCase().includes(search))),
    );
}

function shown(d: Snapshot): Candidate[] {
    return found(d).filter((c) => ui.stage === "all" || flowStage(c) === ui.stage);
}

function openCounts(c: Candidate): string {
    const open = c.findings.filter((f) => f.state === "open");
    return (["blocker", "conflict", "input"] as const).map((level) => [level, open.filter((f) => f.level === level).length] as const)
        .filter(([, n]) => n).map(([level, n]) => `${n} ${level}`).join(", ");
}

function renderCandidates(d: Snapshot): void {
    const entities = [...new Set(d.candidates.map((c) => c.entity))].sort();
    const selected = d.candidates.find((c) => c.key === ui.selected) ?? null;
    const search = h("input", { type: "search", placeholder: "Find a key or an open finding", value: ui.search });
    search.addEventListener("input", () => {
        ui.search = search.value;
        renderList();
    });
    const listHost = h("ul", { class: "candidate-list" });
    const chipsHost = h("div", { class: "chips stage-chips" });
    const all = h("input", { type: "checkbox", title: "Check every candidate shown" });
    const shownCount = h("span");
    const renderList = () => {
        clear(listHost);
        clear(chipsHost);
        const matching = found(d);
        const counts = stageCounts(matching);
        add(chipsHost, [["all", matching.length] as const, ...FLOW.filter((s) => counts.get(s)).map((s) => [s, counts.get(s) ?? 0] as const)].map(([s, n]) =>
            h("button", { class: `chip${ui.stage === s ? " on" : ""}`, onclick: () => {
                ui.stage = s;
                persist();
                render();
            } }, `${s} ${n}`)));
        const now = shown(d);
        shownCount.textContent = `${now.length} shown, ${checked.size} checked`;
        all.checked = now.length > 0 && now.every((c) => checked.has(c.key));
        add(listHost, now.slice(0, 500).map((c) => {
            const box = h("input", { type: "checkbox", checked: checked.has(c.key), onclick: (e: Event) => e.stopPropagation() });
            box.addEventListener("change", () => {
                box.checked ? checked.add(c.key) : checked.delete(c.key);
                render();
            });
            return h("li", { class: c.key === ui.selected ? "on" : "", onclick: () => select(c.key) },
                box,
                h("div", { class: "who", title: [c.entity, openCounts(c)].filter(Boolean).join(", ") }, h("span", { class: "mono key" }, c.key), c.gone ? h("span", { class: "small muted" }, "gone from the sources") : null),
                badge(c.stage, STAGE_CLASS[flowStage(c)]),
            );
        }));
        if (now.length > 500) {
            add(listHost, h("li", { class: "muted small" }, `${now.length - 500} more, narrow the search`));
        }
    };
    all.addEventListener("change", () => {
        shown(d).forEach((c) => (all.checked ? checked.add(c.key) : checked.delete(c.key)));
        render();
    });
    add(left,
        entities.length > 1 ? h("select", { class: "entity", onchange: (e: Event) => {
            ui.entity = (e.target as HTMLSelectElement).value;
            persist();
            render();
        } }, [["all", "every entity"], ...entities.map((e) => [e, e])].map(([v, label]) => h("option", { value: v, selected: v === ui.entity }, label))) : null,
        chipsHost,
        search,
        h("label", { class: "check small" }, all, shownCount),
        listHost,
    );
    renderList();
    if (selected) {
        renderDetail(selected);
    } else {
        add(content, h("p", { class: "muted" }, d.candidates.length ? "Select a candidate." : "No candidates: fetch the sources, observe, then identify (Pipeline)."));
    }
    if (checked.size > 1) {
        renderBulk(d.candidates.filter((c) => checked.has(c.key)));
    } else if (selected) {
        renderActions(selected);
    }
}

function select(key: string): void {
    if (ui.selected !== key) {
        picked.clear();
        drafts.clear();
        reason = "";
    }
    ui.selected = key;
    persist();
    render();
}

function renderDetail(c: Candidate): void {
    add(content,
        h("div", { class: "title" }, h("h2", { class: "mono" }, c.key), badge(c.stage, STAGE_CLASS[flowStage(c)]), h("span", { class: "muted" }, c.entity),
            c.gone ? h("span", { class: "muted", title: "Applied, but the sources no longer have it: kept for its instance" }, "gone from the sources") : null,
            h("span", { class: "muted" }, `review ${c.review.status}${c.review.reason ? `: ${c.review.reason}` : ""}`)),
        h("div", { class: "wrap small" }, c.files.map((f) => fileButton(`${c.folder}/${f}`, f))),
    );
    if (c.result) {
        add(content, instanceSection(c), changesSection(c));
    }
    add(content, findingsSection(c), attributesSection(c), section("Sources", h("ul", { class: "plain mono small muted" }, c.sources.map((s) => h("li", null, s)))));
    if (c.decisions.length) {
        add(content, section("Decisions", h("ul", { class: "plain small" }, c.decisions.map((x) => h("li", { class: "mono" }, Object.entries(x).map(([k, v]) => `${k}: ${short(v, 60)}`).join(", "))))));
    }
}

function findingsSection(c: Candidate): HTMLElement {
    const applied = c.result !== null;
    const editable = c.review.status === "open" && !applied;
    const rows = c.findings.map((f) => findingRow(c, f, editable));
    return section(`Findings${applied ? ", from before apply" : ""}`,
        rows.length ? h("div", { class: "findings" }, rows) : h("p", { class: "muted" }, "No findings: the rules found every attribute and the sources agree."));
}

function findingRow(c: Candidate, f: Finding, editable: boolean): HTMLElement {
    const how = f.state === "set" ? `set to ${short(c.review.set[f.attribute], 60)} in review` : f.state === "accepted" ? "accepted as it is" : "";
    const row = h("div", { class: `finding ${f.state}` },
        badge(f.level, LEVEL_CLASS[f.level]),
        h("span", { class: "mono attr" }, f.attribute),
        h("span", null, f.message, how ? h("span", { class: "resolved-how" }, ` - ${how}`) : null,
            f.level === "conflict" && f.state === "open" ? h("span", { class: "muted" }, ` - now ${short(c.attributes[f.attribute], 60)}`) : null),
    );
    if (!editable || f.state !== "open" || f.level === "blocker") {
        return row;
    }
    const draftKey = `${c.key}|${f.attribute}`;
    const initial = drafts.get(draftKey) ?? (f.suggestion !== null && f.suggestion !== undefined ? yamlValue(f.suggestion) : "");
    const input = h("input", { class: "mono", value: initial, placeholder: "value, as yaml: rocky9, [web, db], true" });
    const code = h("code", { class: "small" });
    const button = h("button", { onclick: () => input.value.trim() && run(["review", "set", c.key, `${f.attribute}=${input.value.trim()}`]) }, "Set");
    const update = () => {
        drafts.set(draftKey, input.value);
        code.textContent = `$ ${commandText(["review", "set", c.key, `${f.attribute}=${input.value.trim() || "<value>"}`])}`;
        (button as HTMLButtonElement).disabled = !input.value.trim();
    };
    input.addEventListener("input", update);
    input.addEventListener("keydown", (e) => e.key === "Enter" && button.click());
    update();
    add(row, h("div", { class: "set-form" },
        f.suggestion !== null && f.suggestion !== undefined ? h("span", { class: "small muted" }, "suggestion, not applied until you set it") : null,
        h("div", { class: "set-row" }, input, button), code));
    return row;
}

function attributesSection(c: Candidate): HTMLElement {
    const canClear = c.review.status === "open" && c.result === null;
    const rows = Object.entries(c.attributes).flatMap(([k, v]) => {
        const set = k in c.review.set || Object.keys(c.review.set).some((s) => s.startsWith(`${k}.`));
        const text = typeof v === "string" ? v : JSON.stringify(v, null, 1);
        const value = text.length > 120 ? h("details", null, h("summary", { class: "mono" }, short(v, 80)), h("pre", { class: "mono" }, text)) : h("span", { class: "mono" }, text);
        const editKey = `${c.key}|${k}`;
        const toggle = () => {
            editing.has(editKey) ? editing.delete(editKey) : editing.add(editKey);
            render();
        };
        const row = h("tr", { class: set ? "set" : "" },
            h("td", { class: "mono" }, k),
            h("td", null, value),
            h("td", null,
                set ? h("span", { class: "small" }, "set in review ") : null,
                canClear && set ? h("button", { class: "link", title: `$ ${commandText(["review", "clear", c.key, k])}`, onclick: () => run(["review", "clear", c.key, k]) }, "clear") : null,
                canClear ? h("button", { class: "link", title: "Set another value in review", onclick: toggle }, editing.has(editKey) ? "cancel" : "change") : null),
        );
        return canClear && editing.has(editKey) ? [row, h("tr", { class: "edit" }, h("td"), h("td", { colspan: "2" }, attributeForm(c, k, v)))] : [row];
    });
    return section("Attributes, what apply sends", h("table", { class: "table attributes" }, h("tbody", null, rows)));
}

/** `review set` for any attribute, also one the rules found: the value set in review overrides it */
function attributeForm(c: Candidate, attribute: string, current: unknown): HTMLElement {
    const draftKey = `${c.key}|${attribute}`;
    const input = valueInput(data?.catalog?.[c.entity]?.[attribute], current, drafts.get(draftKey));
    const code = h("code", { class: "small" });
    const button = h("button", { onclick: () => input.value() !== null && (editing.delete(draftKey), run(["review", "set", c.key, `${attribute}=${input.value()}`])) }, "Set");
    const update = () => {
        drafts.set(draftKey, input.draft());
        code.textContent = `$ ${commandText(["review", "set", c.key, `${attribute}=${input.value() ?? "<value>"}`])}`;
        (button as HTMLButtonElement).disabled = input.value() === null;
    };
    input.element.addEventListener("input", update);
    input.element.addEventListener("change", update);
    input.element.addEventListener("keydown", (e) => e.key === "Enter" && button.click());
    update();
    return h("div", { class: "set-form" }, h("div", { class: "set-row" }, input.element, button), code);
}

/** An input for the catalog type of an attribute; `value()` is the yaml `review set` takes, null while there is none */
interface ValueInput {
    element: HTMLElement;
    value(): string | null;
    draft(): string;
}

function valueInput(type: CatalogAttribute | undefined, current: unknown, draft: string | undefined): ValueInput {
    const base = type?.type.replace(/\?$/, "") ?? "";
    const nullable = type?.type.endsWith("?") ?? false;
    const initial = draft ?? yamlValue(current);
    const choice = (options: string[]): ValueInput => {
        const select = h("select", { class: "mono" }, [...options, ...(nullable ? ["null"] : [])].map((o) => h("option", { value: o }, o))) as HTMLSelectElement;
        select.value = select.querySelector(`option[value="${CSS.escape(initial)}"]`) ? initial : "";
        return { element: select, value: () => select.value || null, draft: () => select.value };
    };
    if (base === "bool") {
        return choice(["true", "false"]);
    }
    if (type?.values && !base.endsWith("[]")) {
        return choice(type.values.map(yamlValue));
    }
    if (type?.values) {
        // enum[]: a checkbox per value, the checked ones as a yaml list
        let picked: string[];
        try {
            picked = draft !== undefined ? JSON.parse(draft) : Array.isArray(current) ? current.map(String) : [];
        } catch (_e) {
            picked = [];
        }
        const boxes = type.values.map((v) => h("input", { type: "checkbox", value: v, checked: picked.includes(v) }) as HTMLInputElement);
        const element = h("div", { class: "enum-list" }, type.values.map((v, i) => h("label", { class: "mono small" }, boxes[i], ` ${v}`)));
        const list = () => JSON.stringify(boxes.filter((b) => b.checked).map((b) => b.value));
        return { element, value: list, draft: list };
    }
    if (base === "int" || base === "float") {
        const number = h("input", { class: "mono", type: "number", step: base === "int" ? "1" : "any", value: initial === "null" ? "" : initial }) as HTMLInputElement;
        return { element: number, value: () => number.value.trim() || (nullable ? "null" : null), draft: () => number.value };
    }
    if (base === "string") {
        // the text as typed: quoted when yaml would read it as something else than this string
        const text = h("input", { class: "mono", value: draft ?? (typeof current === "string" ? current : ""), placeholder: nullable ? "empty for null" : "" }) as HTMLInputElement;
        return { element: text, value: () => (text.value === "" && nullable ? "null" : yamlValue(text.value)), draft: () => text.value };
    }
    const free = h("input", { class: "mono", value: initial, placeholder: "value, as yaml: [web, db], {a: 1}" }) as HTMLInputElement;
    return { element: free, value: () => free.value.trim() || null, draft: () => free.value };
}

function instanceSection(c: Candidate): HTMLElement {
    const r = c.result!;
    const resources = Object.entries(r.resources ?? {});
    return section("Instance",
        h("dl", { class: "kv" },
            h("dt", null, "state"), h("dd", null, r.deleted ? "deleted" : r.state),
            h("dt", null, "version"), h("dd", null, String(r.version)),
            h("dt", null, "read at"), h("dd", null, r.read_at ?? "-"),
            h("dt", null, "id"), h("dd", null, r.id ?? "-"),
            r.gone_at ? [h("dt", null, "gone at"), h("dd", null, `${r.gone_at}: lsm no longer has the instance`)] : null,
        ),
        r.error ? h("div", { class: "instance-error" },
            h("p", null, badge("error", "l-danger"), ` ${r.error.transition}`),
            r.error.compile_error ? h("pre", { class: "mono small" }, r.error.compile_error) : null,
            r.error.compile_report ? h("p", { class: "small muted" }, `validation compile ${r.error.compile_report}`) : null) : null,
        resources.length ? h("details", null, h("summary", null, `${resources.length} resources, ${resources.filter(([, s]) => s !== "deployed").length} not deployed`),
            h("table", { class: "table" }, h("tbody", null, resources.map(([id, state]) => h("tr", null, h("td", { class: "mono small" }, id), h("td", null, badge(state, state === "deployed" ? "l-success" : state === "non_compliant" ? "l-warning" : "l-none"))))))) : null,
    );
}

const CLASS_ORDER = ["safe", "intent", "source", "model", "unsafe", "unclassified"];

function changesSection(c: Candidate): HTMLElement {
    const changes = [...(c.changes ?? [])].sort((a, b) => CLASS_ORDER.indexOf(a.class ?? "unclassified") - CLASS_ORDER.indexOf(b.class ?? "unclassified") || a.resource.localeCompare(b.resource));
    if (!changes.length) {
        return section("Changes", h("p", { class: "muted" }, c.result?.error ? "No changes: lsm took an error transition, see the instance." : "No changes: the instance is compliant."));
    }
    return section(`Changes, worst ${c.worst ?? "-"}`,
        h("p", { class: "help" }, "Classified by rules/diff, numbered by their place in result.yaml. Pick changes to write a diff rule for them."),
        h("div", { class: "changes" }, changes.map((x) => changeRow(x))));
}

interface Leaf {
    path: string;
    current: unknown;
    desired: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The field that names an item of a list, so items are matched by it instead of by position */
function itemKey(items: unknown[]): string | null {
    const objects = items.filter(isObject);
    if (!objects.length || objects.length !== items.length) {
        return null;
    }
    return ["content", "name", "id", "key"].find((k) => objects.every((o) => typeof o[k] === "string" || typeof o[k] === "number")) ?? null;
}

/** Only the values that differ, down to the leaves: `records[a.example.com].comment: null -> mgmt` */
function leaves(current: unknown, desired: unknown, path: string): Leaf[] {
    if (JSON.stringify(current) === JSON.stringify(desired)) {
        return [];
    }
    if (isObject(current) && isObject(desired)) {
        return [...new Set([...Object.keys(current), ...Object.keys(desired)])].flatMap((k) => leaves(current[k], desired[k], path ? `${path}.${k}` : k));
    }
    if (Array.isArray(current) && Array.isArray(desired)) {
        const key = itemKey([...current, ...desired]);
        if (key === null) {
            return Array.from({ length: Math.max(current.length, desired.length) }, (_, i) => leaves(current[i], desired[i], `${path}[${i}]`)).flat();
        }
        const index = (items: unknown[]) => new Map(items.map((o) => [String((o as Record<string, unknown>)[key]), o]));
        const before = index(current);
        const after = index(desired);
        return [...new Set([...before.keys(), ...after.keys()])].flatMap((k) => leaves(before.get(k), after.get(k), `${path}[${short(k, 64)}]`));
    }
    return [{ path, current, desired }];
}

function diffView(x: Change): HTMLElement {
    const found = leaves(x.current, x.desired, x.attribute);
    const value = (v: unknown, tag: "del" | "ins") => (v === undefined ? h("span", { class: "muted" }, tag === "del" ? "(absent)" : "(removed)") : h(tag, null, short(v, 120)));
    return h("table", { class: "diff mono" },
        found.map((l) => h("tr", null, h("td", { class: "path" }, l.path), h("td", null, value(l.current, "del")), h("td", { class: "arrow" }, "->"), h("td", null, value(l.desired, "ins")))));
}

function changeRow(x: Change): HTMLElement {
    const box = h("input", { type: "checkbox", checked: picked.has(x.number), title: "Pick for a diff rule" });
    box.addEventListener("change", () => {
        box.checked ? picked.add(x.number) : picked.delete(x.number);
        render();
    });
    return h("div", { class: "change" },
        h("label", { class: "pick" }, box, h("span", { class: "mono muted" }, `[${x.number}]`)),
        badge(x.class ?? "?", CLASS_CLASS[x.class ?? "unclassified"]),
        h("div", { class: "what" },
            h("div", { class: "mono small muted" }, x.resource),
            diffView(x),
            x.reasons.map((r) => h("div", { class: "small muted" }, r)),
        ),
    );
}

// ---------- actions ----------

function reasonInput(): HTMLInputElement {
    const input = h("input", { value: reason, placeholder: "why, kept in review.yaml or decision.yaml" });
    input.addEventListener("input", () => {
        reason = input.value;
        renderInspectorOnly();
    });
    return input;
}

/** Re-render the inspector without losing the focus of the reason field */
function renderInspectorOnly(): void {
    const active = document.activeElement;
    const position = active instanceof HTMLInputElement ? active.selectionStart : null;
    clear(inspector);
    const d = data!;
    const selected = d.candidates.find((c) => c.key === ui.selected) ?? null;
    if (checked.size > 1) {
        renderBulk(d.candidates.filter((c) => checked.has(c.key)));
    } else if (selected) {
        renderActions(selected);
    }
    const field = inspector.querySelector<HTMLInputElement>("input.reason");
    if (field && active instanceof HTMLInputElement && active.classList.contains("reason")) {
        field.focus();
        field.setSelectionRange(position, position);
    }
}

function reasonField(): HTMLElement {
    const input = reasonInput();
    input.classList.add("reason");
    return h("label", { class: "field" }, h("span", null, "Reason"), input);
}

function renderActions(c: Candidate): void {
    const open = c.findings.filter((f) => f.state === "open");
    const blockers = open.filter((f) => f.level === "blocker");
    const inputs = open.filter((f) => f.level === "input");
    const conflictsOnly = open.length > 0 && open.every((f) => f.level === "conflict");
    const applied = c.result !== null;
    if (!applied) {
        if (c.review.status === "open") {
            add(inspector, section("Review",
                h("div", { class: "actions column" },
                    conflictsOnly
                        ? cmd("Accept, conflicts as they are", ["review", "accept", c.key, "--accept-conflicts"])
                        : cmd("Accept", ["review", "accept", c.key], { why: blockers.length ? `${blockers.length} blocker(s) open: no review clears a blocker, fix the source or the rule` : inputs.length ? `${inputs.length} input(s) open: set them first` : false }),
                    cmd("Edit the values in an editor", ["review", "edit", c.key], { hint: "A draft with a line per open finding opens in a tab; save and close to set, close without saving to abort" }),
                    cmd("Trace the rules", ["identify", "--trace", c.key]),
                ),
                reasonField(),
                h("div", { class: "actions column" }, cmd("Reject", ["review", "reject", c.key, "--reason", reason.trim() || "<why>"], { why: !reason.trim() && "type a reason first" })),
            ));
        } else {
            add(inspector, section("Review", h("p", null, badge(c.review.status, c.review.status === "accepted" ? "l-info" : "l-none"), c.review.reason ? ` ${c.review.reason}` : ""),
                h("div", { class: "actions column" }, cmd("Reopen", ["review", "reopen", c.key], { hint: "Back to open; the values set in review stay" }))));
        }
        if (c.review.status === "accepted") {
            add(inspector, section("Apply",
                h("p", { class: "help" }, "Creates the instance in an onboarding state with an id derived from entity and key. The first deploy only reports."),
                h("div", { class: "actions column" },
                    cmd("Write the request", ["apply", c.key], { hint: "Writes request.json, talks to no orchestrator" }),
                    cmd("Create the instance", ["apply", c.key, "--execute"]),
                )));
        }
        return;
    }
    const changes = c.changes ?? [];
    const notSafe = changes.filter((x) => x.class !== "safe");
    const onboarding = !FLOW.includes(c.stage);
    const numbers = [...picked].sort((a, b) => a - b).map(String);
    const unpicked = notSafe.filter((x) => !picked.has(x.number));
    add(inspector,
        section("Instance",
            h("div", { class: "actions column" },
                cmd("Read it back", ["result"], { hint: "Reads back every applied candidate: state, resources and diff into result.yaml" }),
                cmd("Show the changes", ["changes", c.key]),
                cmd("Write a diff rule for the picked changes", numbers.length ? ["rules", "diff", c.key, ...numbers] : null, { why: !numbers.length && "pick changes in the list first" }),
            )),
        section("Decide",
            h("div", { class: "actions column" },
                cmd("Accept the diff and enforce", ["decide", "enforce", c.key], {
                    why: !onboarding ? `${c.stage}: not in an onboarding state, there is no diff to accept` : notSafe.length ? `${notSafe.length} change(s) are not safe: fix the source or classify them with a diff rule` : false,
                }),
                cmd("Send the reviewed attributes", ["decide", "update", c.key], { why: !onboarding && `${c.stage}: not in an onboarding state` }),
            ),
            reasonField(),
            notSafe.length ? h("div", { class: "actions column" }, cmd("Enforce, accepting the picked changes once",
                ["decide", "enforce", c.key, ...numbers.flatMap((n) => ["--accept", n]), "--reason", reason.trim() || "<why>"], {
                    hint: "No diff rule: the picked changes are taken this time only, logged in decision.yaml with the reason",
                    why: !onboarding ? `${c.stage}: not in an onboarding state` : !numbers.length ? "pick the changes in the list first"
                        : unpicked.length ? `pick the other ${unpicked.length} change(s) that are not safe too: ${unpicked.map((x) => x.number).join(", ")}`
                        : !reason.trim() && "type a reason first",
                })) : null,
            h("div", { class: "actions column" }, cmd("Not ours: delete the instance", ["decide", "reject", c.key, "--reason", reason.trim() || "<why>"], { danger: true, why: !reason.trim() && "type a reason first" })),
        ),
    );
}

/** One form per attribute with open findings among the checked candidates: `review set` on all of them at once */
function bulkSet(candidates: Candidate[]): HTMLElement | null {
    const byAttribute = new Map<string, { keys: string[]; suggestions: Set<string> }>();
    for (const c of candidates.filter((x) => x.review.status === "open" && x.result === null)) {
        for (const f of c.findings.filter((x) => x.state === "open" && x.level !== "blocker")) {
            const entry = byAttribute.get(f.attribute) ?? { keys: [], suggestions: new Set<string>() };
            entry.keys.push(c.key);
            if (f.suggestion !== null && f.suggestion !== undefined) {
                entry.suggestions.add(yamlValue(f.suggestion));
            }
            byAttribute.set(f.attribute, entry);
        }
    }
    if (!byAttribute.size) {
        return null;
    }
    return h("div", { class: "bulk-set" }, [...byAttribute].sort(([a], [b]) => a.localeCompare(b)).map(([attribute, { keys, suggestions }]) => {
        const draftKey = `*|${attribute}`;
        const common = suggestions.size === 1 ? [...suggestions][0] : "";
        const input = h("input", { class: "mono", value: drafts.get(draftKey) ?? common, placeholder: "value, as yaml" });
        const code = h("code", { class: "small" });
        const args = () => ["review", "set", ...keys, `${attribute}=${input.value.trim()}`];
        const button = h("button", { onclick: () => input.value.trim() && runAndUncheck(args(), keys) }, "Set");
        const update = () => {
            drafts.set(draftKey, input.value);
            const assignment = `${attribute}=${input.value.trim() || "<value>"}`;
            code.textContent = keys.length > 2
                ? `$ ${commandText(["review", "set", keys[0]])} ...${keys.length - 1} more ${shellArg(assignment)}`
                : `$ ${commandText(["review", "set", ...keys, assignment])}`;
            (button as HTMLButtonElement).disabled = !input.value.trim();
        };
        input.addEventListener("input", update);
        input.addEventListener("keydown", (e) => e.key === "Enter" && button.click());
        update();
        return h("div", { class: "field" },
            h("label", null, `Set ${attribute} on ${keys.length} with it open`,
                suggestions.size > 1 ? h("span", { class: "small muted" }, ` - ${suggestions.size} different suggestions`) : null),
            h("div", { class: "set-row" }, input, button), code);
    }));
}

function renderBulk(candidates: Candidate[]): void {
    const keys = candidates.map((c) => c.key);
    const by = (test: (c: Candidate) => boolean) => candidates.filter(test).map((c) => c.key);
    const ready = by((c) => c.review.status === "open" && c.result === null && c.outcome === "ready");
    const accepted = by((c) => c.review.status === "accepted" && c.result === null);
    const safe = by((c) => c.result !== null && !FLOW.includes(c.stage) && (c.changes ?? []).every((x) => x.class === "safe"));
    const open = by((c) => c.review.status === "open" && c.result === null);
    add(inspector,
        section(`${keys.length} checked`,
            h("p", { class: "help" }, "Each command gets only the checked candidates it applies to."),
            h("div", { class: "actions column" },
                cmd(`Accept ${ready.length} ready`, ready.length ? ["review", "accept", ...ready] : null, { why: !ready.length && "none is ready", uncheck: ready }),
                cmd(`Create ${accepted.length} instance(s)`, accepted.length ? ["apply", ...accepted, "--execute"] : null, { why: !accepted.length && "none is accepted and not applied", uncheck: accepted }),
                cmd(`Enforce ${safe.length} with only safe changes`, safe.length ? ["decide", "enforce", ...safe] : null, { why: !safe.length && "none is onboarding with only safe changes", uncheck: safe }),
            ),
            bulkSet(candidates),
            reasonField(),
            h("div", { class: "actions column" },
                cmd(`Reject ${open.length} open`, open.length ? ["review", "reject", ...open, "--reason", reason.trim() || "<why>"] : null, { why: !open.length ? "none is open" : !reason.trim() && "type a reason first", uncheck: open }),
            ),
            h("button", { class: "link", onclick: () => {
                checked.clear();
                render();
            } }, "Uncheck all"),
        ),
    );
}

// ---------- messages ----------

window.addEventListener("message", (event: MessageEvent) => {
    const message = event.data as { type: "load"; data: Snapshot; command: string } | { type: "error"; message: string };
    if (message.type === "load") {
        data = message.data;
        command = message.command;
        error = null;
        const keys = new Set(data.candidates.map((c) => c.key));
        [...checked].filter((k) => !keys.has(k)).forEach((k) => checked.delete(k));
    } else {
        error = message.message;
    }
    render();
});

render();
post({ type: "ready" });
