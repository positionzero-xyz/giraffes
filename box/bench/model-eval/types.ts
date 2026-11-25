import type { Usage } from "../../src/claude.ts";

export const HARNESSES = ["claude-code", "codex"] as const;
export type Harness = (typeof HARNESSES)[number];

export const EFFORTS = ["default", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export type Candidate = { readonly harness: Harness; readonly model: string; readonly effort: Effort };

export const SHAPES = ["chat", "reminder", "draft", "build"] as const;
export type Shape = (typeof SHAPES)[number];

export type Contract = "product" | "planned";
/** How a shape is graded: on what the person receives (product) or on the full reply (planned). */
export const CONTRACT: Readonly<Record<Shape, Contract>> = { chat: "product", reminder: "product", draft: "planned", build: "planned" };
/** Whether a run took a path Giraffe ships. Giraffe has no Codex path, so a Codex run is graded like its shape but labelled planned. */
export const contractOf = (harness: Harness, shape: Shape): Contract => (harness === "codex" ? "planned" : CONTRACT[shape]);

export type Wall = string & { readonly __wall: unique symbol };

export type Phrase = { readonly label: string; readonly any: readonly string[] };
export type Unit = "baht" | "percent" | "cm";
/** One fact of a brief: stated, never claimed, every amount with a unit in `need` or `allow`, a December range, or an old and a new price. */
export type Fact =
  | { readonly kind: "says"; readonly label: string; readonly any: readonly string[] }
  | { readonly kind: "never"; readonly label: string; readonly any: readonly string[] }
  | { readonly kind: "amounts"; readonly label: string; readonly unit: Unit; readonly need: readonly number[]; readonly allow: readonly number[] }
  | { readonly kind: "dates"; readonly label: string; readonly from: number; readonly to: number }
  | { readonly kind: "was_now"; readonly label: string; readonly was: number; readonly now: number };
export type Reading = { readonly label: string; readonly at: Wall };
export type Repeat = "daily" | "weekdays" | "weekly";

export type Check =
  | { readonly kind: "thai"; readonly min: number }
  | { readonly kind: "no_jargon" }
  | { readonly kind: "mentions"; readonly what: string; readonly any: readonly string[] }
  | { readonly kind: "fits_reply" }
  /** The model's own message reaches the person; a quiet turn or a notice alone fails. */
  | { readonly kind: "replies" }
  /** One reminder, asked for, at one of `readings`, repeating exactly so, whose note names the job; the reply states no other time or cadence. */
  | { readonly kind: "due_at"; readonly readings: readonly Reading[]; readonly repeat: Repeat | null; readonly about: readonly string[] }
  /** Asks which time, or sets one asked-for one-off reminder on `date` within the hours and says when. */
  | { readonly kind: "asks_or_assumes"; readonly date: string; readonly fromHour: number; readonly toHour: number; readonly about: readonly string[] }
  | { readonly kind: "facts"; readonly facts: readonly Fact[] }
  | { readonly kind: "length"; readonly min: number; readonly max: number }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "html_complete"; readonly path: string }
  | { readonly kind: "page_has"; readonly items: readonly Phrase[] }
  | { readonly kind: "loads_clean" }
  | { readonly kind: "persists"; readonly shown: boolean };

export type CheckResult = { readonly check: string; readonly pass: boolean; readonly detail: string };

export type Wakeup = { readonly at: string; readonly repeat: Repeat | null; readonly asked: boolean; readonly note: string };

export type PersistReport = { readonly ok: boolean; readonly shown: boolean; readonly reason: string };
export type PageReport = { readonly loaded: boolean; readonly errors: readonly string[]; readonly text: string; readonly persist: PersistReport | null };

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
};

export type Rubric = { readonly criteria: readonly { readonly key: string; readonly ask: string }[] };

export type Case = {
  readonly id: string;
  readonly shape: Shape;
  readonly brief: string;
  readonly judged: boolean;
  readonly make: (now: Wall) => { readonly message: string; readonly checks: readonly Check[] };
};

/** `cut_off` and `refused`: the CLI answered but stopped at the output limit or refused, which the Worker treats as a failed turn. */
export type RunStatus = "ok" | "timeout" | "claude_failed" | "codex_failed" | "usage_limit" | "signed_out" | "invalid_output" | "cut_off" | "refused" | "harness_error";

/** What the tap saw of one CLI run. `firstTextMs` is the first assistant text, which the Worker never sends; null spend means none was reported. */
export type Tap = {
  readonly firstTextMs: number | null;
  readonly wallMs: number;
  readonly killed: boolean;
  readonly costUsd: number | null;
  readonly usage: Usage | null;
  readonly models: readonly string[];
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
  /** Tools other than Giraffe's that showed up in the harness's events. */
  readonly otherTools: readonly string[];
  readonly rejected: readonly string[];
  readonly wakeups: readonly Wakeup[];
  readonly checks: readonly CheckResult[];
  readonly wallMs: number | null;
  readonly firstTextMs: number | null;
  readonly usage: Usage | null;
  readonly costUsd: number | null;
  readonly models: readonly string[];
  readonly buildDir: string | null;
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
  readonly codex: CodexMeta | null;
};

export type CodexMeta = { readonly cli: string; readonly version: string | null; readonly profile: string; readonly provider: string; readonly tools: Readonly<Partial<Record<"turn" | "build", readonly string[]>>> };

export type RunFile = { readonly meta: RunMeta; readonly records: RunRecord[] };
