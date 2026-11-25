import type { RunFile, RunRecord, Wall } from "../types.ts";

export const record = (more: Partial<RunRecord>): RunRecord => ({
  id: "haiku@low:chat-advice:1",
  candidate: "haiku@low",
  harness: "claude-code",
  model: "haiku",
  effort: "low",
  shape: "chat",
  caseId: "chat-advice",
  rep: 1,
  contract: "product",
  now: "2026-11-26T10:00" as Wall,
  machineDate: "2026-11-26",
  dateMismatch: false,
  status: "ok",
  message: "",
  reply: "",
  delivered: null,
  overReplyCap: false,
  calls: [],
  refusedCalls: [],
  otherTools: [],
  rejected: [],
  wakeups: [],
  checks: [{ check: "thai", pass: true, detail: "" }],
  wallMs: 5_000,
  firstTextMs: null,
  usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  costUsd: 0.001,
  models: [],
  buildDir: null,
  ...more,
});

export const runOf = (records: RunRecord[]): RunFile => ({
  meta: { startedAt: "2026-11-26T03:00:00Z", gitSha: "abc", cliVersion: "1", cli: "claude", auth: null, now: "2026-11-26T10:00" as Wall, nowPinned: true, argv: [], codex: null },
  records,
});
