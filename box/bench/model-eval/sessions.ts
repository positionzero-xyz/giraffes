import { agentArgs, agentTurn, type AgentReply, type SessionStore } from "../../src/claude.ts";
import { readTap } from "./evidence.ts";
import { agentRequest, CONTROL_MODEL } from "./product.ts";
import type { Candidate, SessionStage, Setup, Tap, Wall } from "./types.ts";

export const SWITCH: Candidate = { harness: "claude-code", model: "sonnet", effort: "default" };
const SWITCH_SEED = "นัดเจอกันที่ทางเข้าฝั่งตะวันออกตอน 16:30 นะ ตอบรับสั้น ๆ ก็พอ ยังไม่ต้องตั้งเตือน";
const HISTORY_SEED = "แมวของฉันชื่อขนุน ส่วนต้นไม้ฉันรดน้ำทุกวันอาทิตย์นะ ไม่ต้องบันทึกหรือเตือน ตอบว่ารับทราบก็พอ";
const TARGET = 90_000;
const SEED_TURNS = 16;

const input = (tap: Tap | null) => (tap?.usage?.input_tokens ?? 0) +
  (tap?.usage?.cache_read_input_tokens ?? 0) + (tap?.usage?.cache_creation_input_tokens ?? 0);

function historyChunk(stage: number): string {
  const rows = Array.from({ length: 300 }, (_, i) => {
    const n = stage * 300 + i;
    const sample = Math.imul(n + 1, 1597334677) >>> 0;
    return `Entry ${n} / basket ${sample.toString(36)}: ${sample % 19} clay cups, ${sample % 11} blue linen bags, ${sample % 23} bamboo trays. Delivery receipt ${(sample ^ n).toString(16)}.`;
  });
  return ["รายการส่งของชุดนี้เอาไว้คุยทีหลัง ยังไม่ต้องบันทึกหรือเตือน ตอบแค่รับทราบนะ", ...rows].join("\n");
}

type Command = (tapFile: string) => readonly [string, ...string[]];
type SessionTurn = { readonly reply: AgentReply; readonly tap: Tap | null; readonly stages: readonly SessionStage[] };
export type SessionRun = SessionTurn | { readonly stages: readonly SessionStage[]; readonly error: string };

function seedCandidate(candidate: Candidate, setup?: Setup): Candidate {
  return setup === "switch" ? { ...candidate, model: CONTROL_MODEL, effort: "default" } : candidate;
}

export function dryProduct(c: Candidate, message: string, now: Wall, setup?: Setup) {
  const steps: { candidate: Candidate; message: string; resume: boolean; description?: string }[] = [];
  if (setup === "switch" || setup === "long") {
    steps.push({ candidate: seedCandidate(c, setup), message: setup === "switch" ? SWITCH_SEED : HISTORY_SEED, resume: false, description: "seed turn" });
    if (setup === "long") steps.push({ candidate: c, message: historyChunk(0), resume: true, description: `repeat with fresh synthetic rows until a seed reports at least ${TARGET} input and cache tokens (up to ${SEED_TURNS} chunks)` });
  }
  steps.push({ candidate: c, message, resume: steps.length > 0 });
  return steps.map((step) => {
    const req = agentRequest(step.candidate, step.message, now, setup);
    return {
      args: agentArgs(req, "<tools.json>", { id: "<session id>", resume: step.resume }),
      stdin: JSON.stringify({ type: "user", message: { role: "user", content: req.turn } }),
      description: step.description,
    };
  });
}

export async function runSession(command: Command, tapFile: string, c: Candidate, message: string, now: Wall, setup?: Setup): Promise<SessionRun> {
  let saved: string | null = null;
  const sessions: SessionStore = { get: () => saved, set: (id) => { saved = id; } };
  const stages: SessionStage[] = [];
  async function turn(candidate: Candidate, prompt: string, file: string) {
    const before = sessions.get();
    const reply = await agentTurn(command(file), agentRequest(candidate, prompt, now, setup), sessions);
    const tap = readTap(file);
    if (setup === "long" || setup === "switch") {
      const resumed = before !== null && sessions.get() === before && tap?.sessionId === before;
      stages.push({ requestedModel: candidate.model, resumed, tap });
    }
    return { reply, tap, stages };
  }
  if (setup !== "long" && setup !== "switch") return turn(c, message, tapFile);

  const first = await turn(seedCandidate(c, setup), setup === "long" ? HISTORY_SEED : SWITCH_SEED, tapFile + ".seed-0");
  if (first.reply.status !== 200 || first.reply.body.stop !== "end" || !sessions.get() || first.tap?.sessionId !== sessions.get()) {
    return { stages, error: "could not seed the box session" };
  }
  if (setup === "long") {
    let observed = input(first.tap);
    for (let i = 0; observed < TARGET && i < SEED_TURNS; i++) {
      const seed = await turn(c, historyChunk(i), tapFile + `.seed-${i + 1}`);
      if (seed.reply.status !== 200 || seed.reply.body.stop !== "end" || !stages.at(-1)?.resumed) return { stages, error: "history seed could not resume" };
      observed = input(seed.tap);
    }
    if (observed < TARGET) return { stages, error: `last seed reported only ${observed} input and cache tokens` };
  }

  const final = await turn(c, message, tapFile);
  if (final.reply.status === 200 && !stages.at(-1)?.resumed) return { stages, error: "CLI did not report the same session on the final turn" };
  return final;
}
