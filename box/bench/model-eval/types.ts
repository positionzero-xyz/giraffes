import type { Usage } from "../../src/claude.ts";

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

export type Check =
  | { readonly kind: "thai"; readonly min: number }
  | { readonly kind: "no_jargon" }
  | { readonly kind: "mentions"; readonly what: string; readonly any: readonly string[] }
  | { readonly kind: "fits_reply" }
  | { readonly kind: "worker_accepts" }
  | { readonly kind: "due_at"; readonly readings: readonly Reading[]; readonly repeat?: Repeat }
  | { readonly kind: "asks_or_assumes"; readonly fromHour: number; readonly toHour: number }
  | { readonly kind: "facts"; readonly facts: readonly Phrase[] }
  | { readonly kind: "length"; readonly min: number; readonly max: number }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "html_complete"; readonly path: string }
  | { readonly kind: "page_has"; readonly items: readonly Phrase[] }
  | { readonly kind: "loads_clean" }
  | { readonly kind: "persists"; readonly shown: boolean };

export type CheckResult = { readonly check: string; readonly pass: boolean; readonly detail: string };

export type Wakeup = { readonly at: string; readonly repeat: Repeat | null; readonly asked: boolean };

export type PersistReport = { readonly ok: boolean; readonly shown: boolean; readonly reason: string };
export type PageReport = { readonly loaded: boolean; readonly errors: readonly string[]; readonly text: string; readonly persist: PersistReport | null };

export type Observation = {
  readonly text: string;
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

export type RunStatus = "ok" | "timeout" | "claude_failed" | "signed_out" | "invalid_output" | "harness_error";

export type Tap = { readonly firstTextMs: number | null; readonly wallMs: number; readonly killed: boolean; readonly costUsd: number | null; readonly models: readonly string[] };

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
  readonly overReplyCap: boolean;
  readonly calls: readonly unknown[];
  readonly refusedCalls: readonly unknown[];
  readonly rejected: readonly string[];
  readonly wakeups: readonly Wakeup[];
  readonly checks: readonly CheckResult[];
  readonly wallMs: number;
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
};

export type RunFile = { readonly meta: RunMeta; readonly records: RunRecord[] };
