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
    review: { status: "open" | "accepted" | "rejected"; set: Record<string, unknown>; accepted_conflicts: string[]; reason: string };
    sources: string[];
    attributes: Record<string, unknown>;
    findings: Finding[];
    files: string[];
    result: { state: string; version: number; read_at: string; id: string; deleted: boolean; resources: Record<string, string> | null } | null;
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
    errors: string[];
}
