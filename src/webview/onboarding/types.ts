/** What `onboard status --json` prints, see onboard/studio.py in the onboarding engine */

export type Level = "blocker" | "conflict" | "input";

export interface Finding {
    attribute: string;
    level: Level;
    message: string;
    suggestion: unknown;
    state: "open" | "set" | "accepted";
}

export interface Change {
    number: number;
    resource: string;
    resource_type: string;
    attribute: string;
    current: unknown;
    desired: unknown;
    class: string | null;
    reasons: string[];
    rules: string[];
}

export interface Candidate {
    entity: string;
    key: string;
    folder: string;
    stage: string;
    outcome: "blocked" | "review" | "ready";
    gone: boolean;
    review: { status: "open" | "accepted" | "rejected"; set: Record<string, unknown>; accepted_conflicts: string[]; reason: string };
    sources: string[];
    attributes: Record<string, unknown>;
    findings: Finding[];
    files: string[];
    result: { state: string; version: number; read_at: string; id: string; deleted: boolean; gone_at?: string | null; resources: Record<string, string> | null; error?: InstanceError | null } | null;
    changes: Change[] | null;
    worst: string | null;
    decisions: Record<string, unknown>[];
}

export interface Snapshot {
    workspace: { root: string; name: string; orchestrator: { url?: string; environment?: string } | null };
    stages: string[];
    classes: string[];
    sources: { name: string; plugin: string; latest: string | null; fetched_at: string | null }[];
    observations: { type: string; source: string | null; count: number | null }[];
    rules: string[];
    candidates: Candidate[];
    /** per entity, and per embedded entity as `Entity.embedded`: the type of each attribute in lsm notation */
    catalog: Record<string, Record<string, CatalogAttribute>>;
    errors: string[];
}

export interface CatalogAttribute {
    type: string;
    values: string[] | null;
    required: boolean;
}

/** Why lsm took an error transition into the current version */
export interface InstanceError {
    transition: string;
    compile_report: string | null;
    compile_error: string | null;
}

/** A background step of `onboard serve` */
export interface Step {
    name: string;
    command: string;
    state: "fresh" | "stale" | "running" | "failed" | "never";
    error: string | null;
    last_run: string | null;
    next_run: string | null;
}

/** A command the engine ran: an action of the user or a background step */
export interface Activity {
    at: string;
    kind: "action" | "step";
    command: string;
    ok: boolean;
    output: string;
}
