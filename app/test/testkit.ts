/**
 * Scenarios use dates in 2099. The runtime fires a stored alarm on its own once the real clock passes
 * it, which would race the test's explicit runs; far-future fake times keep every alarm in the future.
 */
import { createHmac } from "node:crypto";
import { env, runInDurableObject, SELF } from "cloudflare:test";
import worker from "../src/worker";
import { d1Billing, type BillingStore } from "../src/billing/store";
import type { CheckoutId, CheckoutRequest, StripeApi, StripeReply } from "../src/billing/stripe";
import { loadConfig, type BillingConfig, type Env } from "../src/config";
import type { Agent, AgentSnapshot, BillingDeps, BoxDeps } from "../src/agent/agent";
import type { TurnOutput } from "../src/agent/turn";
import { boxClient } from "../src/box/client";
import type { BoxHost, HostResult } from "../src/box/host";
import { boxName, type BoxName } from "../src/box/names";
import type { ChannelAdapter } from "../src/channels/channel";
import type { AdmissionMode } from "../src/agent/admission";
import { eventKey, parseChoice, personAgentKey, type AgentKey, type ChannelEvent, type EpochMs, type Identity, type LocalDateTime, type MicroUsd } from "../src/domain";
import { d1Ledger, type Ledger, type LogRow } from "../src/ledger/ledger";
import { scripted, scriptedConnect, type ScriptStep, type ScriptedModel } from "../src/model/scripted";
import type { QuotaReading } from "../src/policy/quota";
import { DEFAULT_TIME_ZONE, fromLocal, toLocal } from "../src/policy/time";
import { devLane, DEV_URL_SCRIPTED, type IncludedConfig, type KeysConfig } from "../src/access/access";
import { seal } from "../src/access/key";
import { AgentStore } from "../src/agent/store";
import { connect, SecretKey, type Fetch, type ProviderTimeouts, type SchemaMode } from "../src/model/client";
import { PROVIDERS, type ProviderId } from "../src/model/providers";

export { scripted };

export const local = (s: string): EpochMs => fromLocal(s as LocalDateTime, DEFAULT_TIME_ZONE);
export const wall = (t: EpochMs): string => toLocal(t, DEFAULT_TIME_ZONE);

export type FakeClock = { now(): EpochMs; set(t: EpochMs): void };

export function fakeClock(start: EpochMs): FakeClock {
  let t = start;
  return {
    now: () => t,
    set(next) {
      t = next;
    },
  };
}

export type MemoryLedger = Ledger & {
  lineQuotaReading: { readonly at: EpochMs; readonly month: string; readonly limit: number | null; readonly used: number } | null;
  readonly rows: readonly LogRow[];
  readonly boxes: ReadonlyMap<string, { readonly name: string; readonly host: string }>;
};

export function memoryLedger(): MemoryLedger {
  const rows: LogRow[] = [];
  const seen = new Set<string>();
  const boxes = new Map<string, { name: string; host: string }>();
  const seats = d1Ledger(env.LEDGER);
  return {
    checkInvite: (req) => seats.checkInvite(req),
    claimSeat: (req) => seats.claimSeat(req),
    issueInvite: (req) => seats.issueInvite(req),
    lineQuotaReading: null,
    async recordLineQuota() {},
    async lineQuota() {
      return this.lineQuotaReading as QuotaReading | null;
    },
    async lineQuotaAlerts() {
      return [];
    },
    async lineQuotaAlerted() {},
    rows,
    boxes,
    async claimBox(req) {
      if (!boxes.has(req.agent) && boxes.size >= req.max) return "full";
      if (!boxes.has(req.agent)) boxes.set(req.agent, { name: req.name, host: req.host });
      return "granted";
    },
    async releaseBox(agent) {
      boxes.delete(agent);
    },
    async append(batch) {
      for (const row of batch) {
        const key = `${row.stream}:${row.id}`;
        if (!seen.has(key)) rows.push(row);
        seen.add(key);
      }
    },
  };
}

export const TEST_KEY_SECRET = "test-key-secret-0123456789abcdef0123";
export const TEST_KEYS: Extract<KeysConfig, { on: true }> = {
  on: true,
  secrets: { current: TEST_KEY_SECRET, previous: null },
  publicUrl: "https://giraffes.test",
  defaultCapMicro: 5_000_000 as MicroUsd,
};

export const INCLUDED_VARS = {
  INCLUDED: "on",
  INCLUDED_PROVIDER: "anthropic",
  INCLUDED_MODEL: "claude-haiku-5-5",
  INCLUDED_API_KEY: "sk-ant-ours-0123456789",
} as const;

export type ProviderStep =
  | { readonly kind: "output"; readonly value: unknown; readonly usage?: { readonly input?: number; readonly output?: number } }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "status"; readonly status: number; readonly retryAfter?: string; readonly body?: unknown }
  /** A 200 whose body is exactly `body`, such as a reply with no usage. */
  | { readonly kind: "raw"; readonly body: unknown }
  /** Never answers; only the request's abort signal ends it, as a real stalled endpoint would. */
  | { readonly kind: "hang" }
  /** Runs `run` while the request is in flight, then answers with the step it returns. */
  | { readonly kind: "call"; readonly run: () => Promise<ProviderStep> }
  | { readonly kind: "network" };

export type FakeProvider = Fetch & {
  readonly steps: ProviderStep[];
  readonly seen: { readonly url: string; readonly headers: Headers; readonly body: Record<string, unknown> }[];
};

/** A provider's HTTP API behind a fake fetch, answering in the protocol each request's path names. */
export function fakeProvider(steps: readonly ProviderStep[] = []): FakeProvider {
  const queue = [...steps];
  const seen: FakeProvider["seen"] = [];
  const f = async (input: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    seen.push({ url: input, headers: new Headers(init?.headers), body });
    const next = queue.shift();
    if (!next) throw new Error(`the provider got a request the test didn't script: ${input}`);
    const step = next.kind === "call" ? await next.run() : next;
    if (step.kind === "call") throw new Error("a call step must answer with another kind");
    if (step.kind === "network") throw new TypeError("fetch failed");
    if (step.kind === "raw") return new Response(typeof step.body === "string" ? step.body : JSON.stringify(step.body), { headers: { "content-type": "application/json" } });
    if (step.kind === "hang") {
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        if (signal) signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    if (step.kind === "status") {
      return Response.json(step.body ?? { error: "scripted" }, { status: step.status, headers: step.retryAfter ? { "retry-after": step.retryAfter } : {} });
    }
    const text = step.kind === "text" ? step.text : JSON.stringify(step.value);
    const input_tokens = step.kind === "output" ? (step.usage?.input ?? 1000) : 1000;
    const output_tokens = step.kind === "output" ? (step.usage?.output ?? 100) : 100;
    if (input.endsWith("/chat/completions")) {
      return Response.json({ choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: input_tokens, completion_tokens: output_tokens } });
    }
    return Response.json({ content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens, output_tokens } });
  };
  return Object.assign(f, { steps: queue, seen });
}

/** Stores a sealed key in the person's DO, as a key entered on the page would be after its probe. */
export async function giveKey(
  agent: AgentKey,
  k: { readonly provider?: ProviderId; readonly model?: string; readonly key?: string; readonly mode?: SchemaMode; readonly capMicro?: number; readonly backup?: boolean; readonly baseUrl?: string } = {},
): Promise<void> {
  const provider = k.provider ?? "opencode-go";
  const p = PROVIDERS[provider];
  const baseUrl = k.baseUrl ?? p.baseUrl ?? "https://llm.example.com/v1";
  const key = SecretKey.from(k.key ?? "oc_sk_test_0123456789")!;
  const sealed = await seal(TEST_KEY_SECRET, agent, { provider, baseUrl, key });
  const stub = env.AGENT.get(env.AGENT.idFromName(agent));
  await runInDurableObject(stub, (_agent, state) => {
    const store = new AgentStore(state.storage);
    const saved = store.saveKey(
      { provider, baseUrl, model: k.model ?? p.defaultModel ?? "custom-model", auth: p.auth, mode: k.mode ?? "strict", sealed, hint: key.hint, capMicro: (k.capMicro ?? 5_000_000) as MicroUsd, connectedAt: 0 as EpochMs },
      store.keyRevision(),
      null,
      [],
      0 as EpochMs,
    );
    if (!saved) throw new Error("giveKey: the key wasn't saved");
    if (k.backup !== undefined) store.setBackup(k.backup, 0 as EpochMs, store.keyRevision());
  });
}

export type DeliveryStep =
  | { readonly kind: "sent" }
  | { readonly kind: "retry" | "in_doubt"; readonly afterMs: number }
  | { readonly kind: "throw" }
  | { readonly kind: "gone" };

export type Delivered = {
  readonly at: EpochMs;
  readonly text: string;
  readonly via: "reply" | "push";
  readonly button?: { readonly label: string; readonly data: string };
};

export type ScriptedChannel = ChannelAdapter & { readonly delivered: readonly Delivered[]; readonly shown: readonly Identity[] };

export function scriptedChannel(steps: readonly DeliveryStep[] = []): ScriptedChannel {
  const queue = [...steps];
  const delivered: Delivered[] = [];
  const shown: Identity[] = [];
  return {
    delivered,
    shown,
    working: {
      everyMs: 5,
      show: async (to) => {
        shown.push(to);
      },
    },
    receive: async () => {
      throw new Error("the agent never receives through its channel");
    },
    async deliver(msg, now) {
      const step = queue.shift() ?? { kind: "sent" };
      switch (step.kind) {
        case "sent": {
          const via = msg.reply !== undefined && now < msg.reply.expiresAt ? "reply" : "push";
          delivered.push({ at: now, text: msg.texts.join("\n"), via, ...(msg.button ? { button: msg.button } : {}) });
          return { kind: "sent", via };
        }
        case "retry":
        case "in_doubt":
          return { kind: step.kind, afterMs: step.afterMs, detail: `scripted ${step.kind}` };
        case "throw":
          throw new Error("scripted exception from the channel");
        case "gone":
          return { kind: "recipient_gone" };
      }
    },
  };
}

export type DevChat = {
  readonly agent: AgentKey;
  readonly model: ScriptedModel;
  readonly clock: FakeClock;
  readonly channel: ScriptedChannel;
  post(text: string, opts?: { readonly id?: string; readonly at?: EpochMs }): Promise<Response>;
  say(text: string, opts?: { readonly id?: string; readonly at?: EpochMs }): Promise<void>;
  /** The person taps a button whose data is `data`, such as "a:1.1". */
  tap(data: string): Promise<void>;
  /** Any channel event, past the webhook, such as a Telegram follow with its start code. */
  event(e: ChannelEvent): Promise<void>;
  remove(): Promise<void>;
  settle(): Promise<void>;
  alarm(): Promise<void>;
  advanceTo(local: string): Promise<void>;
  received(): Promise<string[]>;
  snapshot(): Promise<AgentSnapshot>;
  logs<S extends LogRow["stream"]>(stream: S): Extract<LogRow, { stream: S }>[];
};

let messageIds = 0;

export async function devChat(
  user: string,
  opts: {
    /** The dev lane's script; null gives the person no access of ours, so only a key or a box can answer. */
    readonly model: ScriptedModel | null;
    /** Where a person's own key and the included tier send their requests. */
    readonly provider?: Fetch;
    /** Per-purpose provider timeouts, shortened so a stalled endpoint times out within a test. */
    readonly timeouts?: ProviderTimeouts;
    readonly keys?: KeysConfig;
    /** Our included tier, served through `provider`; it replaces the dev lane. */
    readonly included?: IncludedConfig;
    readonly at: string;
    readonly ledger?: MemoryLedger;
    readonly deliveries?: readonly DeliveryStep[];
    readonly box?: BoxDeps;
    readonly billing?: BillingDeps;
    /** A LINE or Telegram person's events go straight into their agent, past the webhook's signature check. */
    readonly channel?: "line" | "telegram";
    /** Open unless the test is about the beta's admission. Billing needs it open. */
    readonly admission?: AdmissionMode;
  },
): Promise<DevChat> {
  const clock = fakeClock(local(opts.at));
  const ledger = opts.ledger ?? memoryLedger();
  const channel = scriptedChannel(opts.deliveries);
  const identity: Identity = { channel: opts.channel ?? "dev", channelUserId: user };
  const stub = env.AGENT.get(env.AGENT.idFromName(personAgentKey(identity)));
  const channels = { line: channel, telegram: channel, dev: channel };
  const box = opts.box ? { box: opts.box } : {};
  const billing = opts.billing ? { billing: opts.billing } : {};
  const admission = opts.admission ?? "open";
  const wire = connect(opts.provider ?? fakeProvider(), opts.timeouts);
  const access = opts.model
    ? { connect: scriptedConnect(opts.model, wire), included: opts.included ?? devLane(DEV_URL_SCRIPTED) }
    : { connect: wire, included: opts.included ?? ({ on: false } as const) };
  const keys = opts.keys ?? TEST_KEYS;
  await runInDurableObject<Agent, void>(stub, (agent) => agent.withDeps({ ...access, keys, clock, ledger, channels, admission, ...box, ...billing }));
  const keyOf = (id: string) => (identity.channel === "line" ? eventKey.line(id) : eventKey.telegram(++messageIds));
  let seen = 0;
  const nextAlarm = () => runInDurableObject(stub, (_agent, state) => state.storage.getAlarm());

  const chat: DevChat = {
    agent: personAgentKey(identity),
    model: opts.model ?? scripted([]),
    clock,
    channel,
    async post(text, o = {}) {
      const body = { user, text, id: o.id ?? `m${++messageIds}`, at: o.at ?? clock.now() };
      if (identity.channel === "dev") return SELF.fetch("https://agent.test/webhook/dev", { method: "POST", body: JSON.stringify(body) });
      const at = body.at as EpochMs;
      await stub.enqueue({ agent: personAgentKey(identity), identity, key: keyOf(body.id), receivedAt: at, event: { kind: "message", text } });
      return new Response("ok");
    },
    async say(text, o) {
      const res = await chat.post(text, o);
      if (!res.ok) throw new Error(`webhook answered ${res.status}`);
      await chat.settle();
    },
    async tap(data) {
      const choice = parseChoice(data);
      if (!choice) throw new Error(`not a button: ${data}`);
      await chat.event({ kind: "choice", choice, at: clock.now() });
    },
    async event(e) {
      const id = `e${++messageIds}`;
      const key = identity.channel === "dev" ? eventKey.dev(id) : keyOf(id);
      await stub.enqueue({ agent: personAgentKey(identity), identity, key, receivedAt: clock.now(), event: e });
      await chat.settle();
    },
    async remove() {
      await stub.remove();
      await chat.settle();
    },
    async settle() {
      for (let i = 0; i < 50; i++) {
        await chat.alarm();
        const next = await nextAlarm();
        if (next === null || next > clock.now()) return;
      }
      throw new Error("the agent never went idle");
    },
    alarm: () => runInDurableObject<Agent, void>(stub, (agent) => agent.alarm()),
    async advanceTo(to) {
      const target = local(to);
      for (;;) {
        const next = await nextAlarm();
        if (next === null || next > target) break;
        clock.set(Math.max(next, clock.now()) as EpochMs);
        await chat.settle();
      }
      clock.set(target);
      await chat.settle();
    },
    async received() {
      const fresh = channel.delivered.slice(seen);
      seen = channel.delivered.length;
      return fresh.map((d) => d.text);
    },
    snapshot: () => stub.snapshot(),
    logs: (stream) => ledger.rows.filter((r): r is Extract<LogRow, { stream: typeof stream }> => r.stream === stream),
  };
  return chat;
}

export function turn(o: {
  readonly actions: unknown[];
  readonly lateNotice?: string;
  readonly tasks?: unknown[];
  readonly about?: string;
  readonly usage?: Extract<ScriptStep, { kind: "output" }>["usage"];
}): ScriptStep {
  const base = { actions: o.actions, tasks: o.tasks ?? [], about: o.about ?? "" };
  const value = o.lateNotice === undefined ? base : { ...base, lateNotice: o.lateNotice };
  return o.usage ? { kind: "output", value, usage: o.usage } : { kind: "output", value };
}
export const send = (text: string) => ({ type: "send", text });
export const schedule = (key: string, at: string, note: string, asked = true, task = "") => ({ type: "schedule_wakeup", key, at, note, asked, task });
export const routine = (key: string, at: string, note: string, repeat: "daily" | "weekdays" | "weekly") => ({ ...schedule(key, at, note), repeat });
export const cancel = (key: string) => ({ type: "cancel_wakeup", key });
export const quiet = () => ({ type: "quiet" });
export const propose = (ref: string, title: string, plan: string, kind = "plan") => ({ op: "propose", ref, kind, title, plan });
export const openTask = (ref: string, title: string, kind = "other") => ({ op: "open", ref, kind, title, plan: "" });
export const throws = (): ScriptStep => ({ kind: "throw" });
export const hold = (then: ScriptStep): ScriptStep => ({ kind: "hold", then });
export const chat = (text: string): ScriptStep => turn({ actions: [send(text)] });

/** The box client reads a thrown fetch as unavailable and the turn retries quietly, so setup fails the test from this list instead. */
export const UNSCRIPTED_BOX_TURNS: string[] = [];
export const BOX_SECRET = "test-secret-0123456789abcdef";

export type HostStep = "ok" | "die" | { readonly retryable: boolean; readonly detail: string };
/** `die` removes the app and then throws, as a crash right after the host call would. */
export type DestroyStep = "ok" | "die" | "fail";

export type BoxReplyStep =
  | { readonly kind: "reply"; readonly step: ScriptStep; readonly refusedCalls?: Readonly<NonNullable<TurnOutput["refusedCalls"]>> }
  | { readonly kind: "signed_out" }
  | { readonly kind: "stale" }
  | { readonly kind: "refusal" }
  | { readonly kind: "status"; readonly status: number };

export type FakeBox = {
  readonly deps: BoxDeps;
  /** Apps the host has created; a step that died after creating one leaves it here, as a real crash would. */
  readonly created: Set<string>;
  readonly ensureCalls: string[];
  /** The image each `ensure` put on its machine. */
  readonly ensuredWith: string[];
  /** BOX_IMAGE as the host sees it; changing it stands for a deploy with a new image. */
  image: string;
  readonly destroyCalls: string[];
  readonly healthCalls: string[];
  readonly parses: {
    readonly authorization: string | null;
    readonly user: string;
    readonly agent: { readonly append: string; readonly tools: readonly string[]; readonly session: string | null; readonly resumed: boolean; readonly fresh: string | null; readonly ephemeral?: boolean } | null;
    /** The volume and forget epoch the request named, or null when it named none. */
    readonly at?: { readonly box: unknown; readonly epoch: unknown } | null;
  }[];
  readonly replies: BoxReplyStep[];
  readonly sessions: Set<string>;
  ignoresSession: boolean;
  signedIn: boolean;
  /** False makes the box's own URL unreachable, as a wedged machine or a network fault would. */
  reachable: boolean;
  nameOf(user: string): Promise<BoxName>;
};

/** A BoxHost and the box's HTTP server behind the real box client, wired through a fake fetch. */
export function fakeBox(
  opts: {
    readonly maxBoxes?: number;
    readonly host?: readonly HostStep[];
    readonly destroy?: readonly DestroyStep[];
    readonly signedIn?: boolean;
    readonly onlyFor?: string;
    /** The volume id the box's /health reports, as an image with erase does. */
    readonly volume?: string;
  } = {},
): FakeBox {
  const steps = [...(opts.host ?? [])];
  const destroySteps = [...(opts.destroy ?? [])];
  const box = {
    created: new Set<string>(),
    ensureCalls: [] as string[],
    ensuredWith: [] as string[],
    image: "registry.test/box:1",
    destroyCalls: [] as string[],
    healthCalls: [] as string[],
    parses: [] as FakeBox["parses"][number][],
    replies: [] as BoxReplyStep[],
    sessions: new Set<string>(),
    ignoresSession: false,
    signedIn: opts.signedIn ?? false,
    reachable: true,
    nameOf: (user: string) => boxName(BOX_SECRET, "gbox-", personAgentKey({ channel: "dev", channelUserId: user })),
  };
  const host: BoxHost = {
    kind: "fly",
    get image() {
      return box.image;
    },
    nameFor: (agent) => boxName(BOX_SECRET, "gbox-", agent),
    urlOf: (name) => `https://${name}.box.test`,
    async ensure(name): Promise<HostResult> {
      box.ensureCalls.push(name);
      const step = steps.shift() ?? "ok";
      if (step === "die") {
        box.created.add(name);
        throw new Error("the host step died after creating the app");
      }
      if (step !== "ok") return { ok: false, ...step };
      box.created.add(name);
      box.ensuredWith.push(box.image);
      return { ok: true };
    },
    async destroy(name): Promise<HostResult> {
      box.destroyCalls.push(name);
      const step = destroySteps.shift() ?? "ok";
      if (step === "fail") return { ok: false, retryable: true, detail: "DELETE /apps: 503" };
      box.created.delete(name);
      if (step === "die") throw new Error("the host step died after destroying the app");
      return { ok: true };
    },
  };
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const name = url.hostname.replace(/\.box\.test$/, "");
    if (url.pathname === "/health") box.healthCalls.push(name);
    if (!box.created.has(name) || !box.reachable) throw new TypeError("fetch failed: no such host");
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/health") {
      return Response.json({ ok: true, signedIn: box.signedIn, authMethod: box.signedIn ? "claude.ai" : "none", version: "test", ...(opts.volume ? { box: opts.volume } : {}) });
    }
    if (url.pathname === "/parse" || url.pathname === "/agent") {
      const agent = url.pathname === "/agent";
      const body = JSON.parse(String(init?.body)) as { user?: string; turn?: string; fresh?: string | null; session?: string | null; append?: string; tools?: { name: string }[]; ephemeral?: boolean; box?: unknown; epoch?: unknown };
      const named = box.ignoresSession ? null : (body.session ?? null);
      const resumed = box.ignoresSession || (named !== null && box.sessions.has(named));
      const session = resumed ? named : crypto.randomUUID();
      const read = agent ? ((resumed ? body.turn : (body.fresh ?? body.turn)) ?? "") : (body.user ?? "");
      box.parses.push({
        authorization,
        user: read,
        agent: agent ? { append: body.append ?? "", tools: (body.tools ?? []).map((t) => t.name), session: body.session ?? null, resumed, fresh: body.fresh ?? null, ...(body.ephemeral === true ? { ephemeral: true } : {}) } : null,
        at: body.box === undefined && body.epoch === undefined ? null : { box: body.box, epoch: body.epoch },
      });
      const step = box.replies.shift();
      if (!step) {
        UNSCRIPTED_BOX_TURNS.push(read.slice(-120));
        throw new Error("the box got a turn the test didn't script");
      }
      if (agent && session !== null && (step.kind === "reply" || step.kind === "refusal")) box.sessions.add(session);
      const reported = box.ignoresSession ? {} : { session: { id: session, resumed } };
      switch (step.kind) {
        case "signed_out":
          return Response.json({ error: "signed_out" }, { status: 409 });
        case "stale":
          return Response.json({ error: "stale" }, { status: 412 });
        case "status":
          return Response.json({ error: "claude_failed" }, { status: step.status });
        case "refusal":
          return Response.json({ text: "", calls: [], ...reported, usage: { input_tokens: 900, output_tokens: 1 }, stop: "refusal" });
        case "reply": {
          if (step.step.kind !== "output") throw new Error("a box reply must be an output step");
          if (!agent) return Response.json({ structured: step.step.value, usage: { input_tokens: 900, output_tokens: 90 }, stop: "end" });
          const { actions, tasks } = step.step.value as { actions: { type: string; text?: string }[]; tasks: Record<string, unknown>[] };
          const text = actions.flatMap((a) => (a.type === "send" ? [a.text ?? ""] : [])).join("\n\n");
          const calls = [
            ...actions.filter((a) => a.type !== "send" && a.type !== "quiet").map(({ type, ...input }) => ({ name: type, input })),
            ...tasks.map((input) => ({ name: "task", input })),
          ];
          return Response.json({ text, calls, refusedCalls: step.refusedCalls, ...reported, usage: { input_tokens: 900, output_tokens: 90 }, stop: "end" });
        }
      }
    }
    return new Response("not found", { status: 404 });
  };
  const deps: BoxDeps = {
    host,
    client: boxClient(fetch),
    secret: BOX_SECRET,
    maxBoxes: opts.maxBoxes ?? 10,
    onlyFor: opts.onlyFor === undefined ? null : personAgentKey({ channel: "dev", channelUserId: opts.onlyFor }),
  };
  return Object.assign(box, { deps });
}

export const STRIPE_VARS = {
  ADMISSION: "open",
  BILLING: "on",
  OPERATOR_CHAT: "telegram:4242",
  TELEGRAM_BOT_TOKEN: "123:abc",
  TELEGRAM_WEBHOOK_SECRET: "tg-test-secret-0123456789abcdefghi",
  STRIPE_SECRET_KEY: "sk_test_fake",
  STRIPE_WEBHOOK_SECRET: "whsec_test_fake",
  STRIPE_PRICE_STANDARD: "price_standard",
  STRIPE_PRICE_PLUS: "price_plus",
  STRIPE_PRICE_SEAT: "price_seat",
  STRIPE_PORTAL_CONFIGURATION: "bpc_fake",
  PUBLIC_URL: "https://giraffes.test",
} as const;

export type FakeStripe = StripeApi & {
  readonly checkouts: CheckoutRequest[];
  /** Checkout sessions by id, as Stripe holds them; a repeated idempotency key gets its session back. */
  readonly sessions: Map<string, "open" | "complete" | "expired">;
  readonly portals: string[];
  failing: boolean;
  expiresFailing: boolean;
  /** What Stripe holds now, by subscription id; each event's handler reads it from here. */
  readonly subscriptions: Map<string, unknown>;
  readsFailing: boolean;
  /** Holds the next read after it has copied the state, until the returned function is called. */
  holdNextRead(): () => void;
};

export function fakeStripe(): FakeStripe {
  let hold: Promise<void> | null = null;
  const stripe: FakeStripe = {
    checkouts: [],
    sessions: new Map(),
    portals: [],
    failing: false,
    expiresFailing: false,
    subscriptions: new Map(),
    readsFailing: false,
    holdNextRead() {
      let release = () => {};
      hold = new Promise((r) => (release = r));
      return release;
    },
    async checkout(req) {
      stripe.checkouts.push(req);
      if (stripe.failing) return { ok: false, status: 500, detail: "checkout 500" };
      const id = `cs_${createHmac("sha256", "cs").update(req.idempotencyKey).digest("hex").slice(0, 12)}` as CheckoutId;
      if (!stripe.sessions.has(id)) stripe.sessions.set(id, "open");
      return { ok: true, value: { id, url: `https://checkout.stripe.test/${req.plan}/${encodeURIComponent(req.idempotencyKey)}` } };
    },
    async expireCheckout(id) {
      if (stripe.expiresFailing) return { ok: false, status: 500, detail: "expire 500" };
      if (stripe.sessions.get(id) !== "open") return { ok: true, value: "gone" };
      stripe.sessions.set(id, "expired");
      return { ok: true, value: "expired" };
    },
    async portal(customer) {
      if (stripe.failing) return { ok: false, status: 500, detail: "portal 500" };
      stripe.portals.push(customer);
      return { ok: true, value: { url: `https://billing.stripe.test/p/${customer}` } };
    },
    async subscription(id): Promise<StripeReply<unknown>> {
      if (stripe.readsFailing) return { ok: false, status: null, detail: "TypeError: fetch failed" };
      const state = structuredClone(stripe.subscriptions.get(id) ?? null);
      const held = hold;
      hold = null;
      if (held) await held;
      return { ok: true, value: state };
    },
  };
  return stripe;
}

export type BillingKit = { readonly deps: BillingDeps; readonly stripe: FakeStripe; readonly config: Extract<BillingConfig, { on: true }> };

/** BILLING=on with the real D1 store and a fake Stripe API. `vars` overrides the env, such as TRIAL_DAYS. */
export function billingOn(vars: Record<string, string> = {}, store: BillingStore = d1Billing(env.LEDGER)): BillingKit {
  const config = loadConfig({ MODEL_BACKEND: "scripted", DEV_MODE: "1", ...STRIPE_VARS, ...vars } as unknown as Env).billing;
  if (!config.on) throw new Error("billingOn needs BILLING=on");
  const stripe = fakeStripe();
  return { deps: { config, store, stripe }, stripe, config };
}

export function signStripe(payload: string, at: number = Date.now(), secret: string = STRIPE_VARS.STRIPE_WEBHOOK_SECRET): string {
  const t = Math.floor(at / 1000);
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;
}

/** Posts to the real Worker route with BILLING=on in its env. */
export async function postStripe(event: unknown, opts: { readonly signature?: string; readonly vars?: Record<string, string> } = {}): Promise<Response> {
  const payload = JSON.stringify(event);
  const req = new Request("https://agent.test/webhook/stripe", {
    method: "POST",
    headers: { "stripe-signature": opts.signature ?? signStripe(payload) },
    body: payload,
  });
  return worker.fetch(req, { ...env, ...STRIPE_VARS, ...opts.vars } as Env);
}

let stripeEvents = 0;

export type StripeSubscriptionOpts = {
  readonly user: string;
  readonly sub: string;
  readonly plan: "standard" | "plus" | "included";
  readonly status: string;
  readonly extraSeats?: number;
  readonly customer?: string;
};

/** A subscription object as `GET /v1/subscriptions/{id}` returns it, on the prices `stripe-setup.ts` makes. */
export function stripeSubscription(o: StripeSubscriptionOpts) {
  const price = (name: string) => ({ id: `price_${name}`, object: "price", product: `giraffes_${name}`, lookup_key: `giraffes_${name}` as string | null });
  const items = [{ price: price(o.plan), quantity: 1 }];
  if (o.extraSeats) items.push({ price: price("seat"), quantity: o.extraSeats });
  return {
    id: o.sub,
    object: "subscription",
    status: o.status,
    customer: o.customer ?? `cus_${o.user}`,
    metadata: { agent_key: personAgentKey({ channel: "dev", channelUserId: o.user }), plan: o.plan as string },
    items: { object: "list", data: items },
  };
}

type SubscriptionEventType = "customer.subscription.created" | "customer.subscription.updated" | "customer.subscription.deleted";

export function subscriptionEvent(o: StripeSubscriptionOpts & { readonly type?: SubscriptionEventType; readonly id?: string }) {
  return {
    id: o.id ?? `evt_${++stripeEvents}`,
    type: o.type ?? "customer.subscription.updated",
    created: Math.floor(Date.now() / 1000),
    data: { object: stripeSubscription(o) },
  };
}

export function checkoutEvent(o: { readonly user: string; readonly sub: string; readonly plan: "standard" | "plus" | "included"; readonly id?: string }) {
  const agent = personAgentKey({ channel: "dev", channelUserId: o.user });
  return {
    id: o.id ?? `evt_${++stripeEvents}`,
    type: "checkout.session.completed",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: `cs_${stripeEvents}`,
        object: "checkout.session",
        mode: "subscription",
        client_reference_id: agent,
        metadata: { agent_key: agent, plan: o.plan },
        subscription: o.sub,
        payment_status: "paid",
      },
    },
  };
}

/** Stripe's state becomes `o`, and Stripe posts the subscription event that says so. */
export function stripeChange(kit: BillingKit, o: StripeSubscriptionOpts & { readonly type?: SubscriptionEventType; readonly id?: string }): Promise<Response> {
  kit.stripe.subscriptions.set(o.sub, stripeSubscription(o));
  return postStripe(subscriptionEvent(o));
}
