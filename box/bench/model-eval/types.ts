import type { Usage } from "../../src/claude.ts";
import type { TurnCommit } from "../../../app/src/agent/turn.ts";

export const HARNESSES = ["claude-code"] as const;
export type Harness = (typeof HARNESSES)[number];

export const EFFORTS = ["default", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export type Candidate = { readonly harness: Harness; readonly model: string; readonly effort: Effort };

export const SHAPES = ["chat", "reminder", "draft", "build"] as const;
export type Shape = (typeof SHAPES)[number];

export type Contract = "product" | "planned";
export const CONTRACT: Readonly<Record<Shape, Contract>> = { chat: "product", reminder: "product", draft: "planned", build: "planned" };

export type Wall = string & { readonly __wall: unique symbol };

export type Phrase = { readonly label: string; readonly any: readonly string[] };
export type Reading = { readonly label: string; readonly at: Wall };
export type Repeat = "daily" | "weekdays" | "weekly";
export type Stop = "end" | "refusal" | "max_tokens";
export type Setup = "parcel" | "long" | "switch";
export type FormDrive = "booking" | "expense";
export type PageDrive = FormDrive | "order";
export type StructuralSignal = "stop_reason" | "tool_rejection" | "reply_cap" | "schema_failure";

export type Check =
  | { readonly kind: "thai"; readonly min: number }
  | { readonly kind: "fits_reply" }
  | { readonly kind: "replies" }
  | { readonly kind: "stops_clean" }
  | { readonly kind: "due_at"; readonly readings: readonly Reading[]; readonly repeat: Repeat | null; readonly cancel?: string; readonly notes?: number }
  | { readonly kind: "asks_or_assumes"; readonly date: string; readonly fromHour: number; readonly toHour: number }
  | { readonly kind: "length"; readonly min: number; readonly max: number }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "page_has"; readonly items: readonly Phrase[] }
  | { readonly kind: "loads_clean" }
  | { readonly kind: "persists"; readonly drive: FormDrive; readonly shown: boolean }
  | { readonly kind: "priced"; readonly items: readonly (Phrase & { readonly price: number })[] }
  | { readonly kind: "total_adds" }
  | { readonly kind: "order_flow" };

export type CheckResult = { readonly check: string; readonly pass: boolean; readonly detail: string; readonly available?: false };

export type Wakeup = { readonly at: string; readonly repeat: Repeat | null; readonly asked: boolean; readonly note: string };

/** After one entry and a reload: whether it was kept and shown, which entered values the saved data lacks, and the shown total before and after. */
export type PersistReport = {
  readonly ok: boolean;
  readonly shown: boolean;
  readonly reason: string;
  readonly missing: readonly string[];
  readonly totalBefore: number | null;
  readonly totalAfter: number | null;
};
export type PageReport = {
  readonly loaded: boolean;
  readonly errors: readonly string[];
  readonly text: string;
  readonly persist: PersistReport | null;
  readonly priceGroups?: readonly string[];
  readonly order?: { readonly ok: boolean; readonly detail: string };
};

/** `text` is what the checks grade: what the person receives on the product path, the full reply on the planned one. */
export type Observation = {
  readonly text: string;
  /** The model's whole reply before the Worker cuts or adds to it. */
  readonly raw: string;
  readonly answered: boolean;
  readonly wakeups: readonly Wakeup[];
  readonly rejected: readonly string[];
  readonly files: Readonly<Record<string, string>>;
  readonly page: PageReport | null;
  readonly workerCommit?: TurnCommit | null;
  readonly stop?: Stop;
};

export type Rubric = { readonly criteria: readonly { readonly key: string; readonly ask: string }[] };

export type Case = {
  readonly id: string;
  readonly shape: Shape;
  readonly brief: string;
  readonly judge: Rubric;
  readonly setup?: Setup;
  readonly make: (now: Wall) => { readonly message: string; readonly checks: readonly Check[] };
};

/** `cut_off` and `refused`: the CLI answered but stopped at the output limit or refused, which the Worker treats as a failed turn. */
export type RunStatus = "ok" | "timeout" | "claude_failed" | "signed_out" | "invalid_output" | "cut_off" | "refused" | "harness_error";

/** What the tap saw of one CLI run. `firstTextMs` is the first assistant text, which the Worker never sends; null spend means none was reported. */
export type Tap = {
  readonly firstTextMs: number | null;
  readonly wallMs: number;
  readonly killed: boolean;
  readonly costUsd: number | null;
  readonly usage: Usage | null;
  readonly models: readonly string[];
  readonly sessionId?: string | null;
  readonly stopReason?: string | null;
  readonly rawOutput?: string | null;
  readonly reportedModel?: string | null;
};

export type SessionStage = {
  readonly requestedModel: string;
  readonly resumed: boolean;
  readonly tap: Tap | null;
};

export type RunRecord = {
  readonly id: string;
  readonly candidate: string;
  readonly harness: Harness;
  readonly model: string;
  readonly effort: Effort;
  readonly shape: Shape;
  readonly caseId: string;
  readonly rep: number;
  readonly contract: Contract;
  readonly now: Wall;
  readonly machineDate: string;
  readonly dateMismatch: boolean;
  readonly status: RunStatus;
  readonly message: string;
  readonly reply: string;
  /** What the Worker would send the person, notices included; null off the product path. */
  readonly delivered: string | null;
  readonly overReplyCap: boolean;
  readonly calls: readonly unknown[];
  readonly refusedCalls: readonly unknown[];
  readonly rejected: readonly string[];
  readonly wakeups: readonly Wakeup[];
  readonly checks: readonly CheckResult[];
  readonly wallMs: number | null;
  readonly firstTextMs: number | null;
  readonly usage: Usage | null;
  readonly costUsd: number | null;
  readonly models: readonly string[];
  readonly buildDir: string | null;
  readonly rawOutput?: string | null;
  readonly reportedModel?: string | null;
  readonly stopReason?: string | null;
  readonly workerCommit?: TurnCommit | null;
  readonly pageReport?: PageReport | null;
  readonly structuralSignals?: readonly StructuralSignal[];
  readonly sessionStages?: readonly SessionStage[];
  readonly replay?: readonly string[];
  readonly error?: string;
};

export type RunMeta = {
  readonly startedAt: string;
  readonly gitSha: string;
  readonly cliVersion: string | null;
  readonly cli: string;
  readonly auth: { readonly loggedIn: boolean; readonly authMethod: string } | null;
  readonly now: Wall;
  readonly nowPinned: boolean;
  readonly argv: readonly string[];
  readonly regradedAt?: string;
};

export type RunFile = { readonly meta: RunMeta; readonly records: RunRecord[] };
