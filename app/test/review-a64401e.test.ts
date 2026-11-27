import { env, runInDurableObject } from 'cloudflare:test';
import { expect, test, vi } from 'vitest';
import { flyHost } from '../src/box/fly';
import type { BoxName } from '../src/box/names';
import type { EpochMs } from '../src/domain';
import { devChat, fakeBox } from './testkit';

const name = 'gbox-erasure-review' as BoxName;
const app = `/v1/apps/${name}`;
const volumes = `${app}/volumes`;
const cfg = { apiToken: 'stub', org: 'giraffes', image: 'stub', region: 'sin', volumeGb: 1, appPrefix: 'gbox-', secret: 'stub' };
const disk = (id: string, machine: string | null = null) => ({ id, attached_machine_id: machine, state: 'created' });
const status = (code: number) => new Response(null, { status: code });
const owner = (slug = cfg.org) => Response.json({ organization: { slug } });
const absent = () => Response.json({ apps: [] });

test.each([403, 404, 500, 200])('an app 404 with invalid org list %i stays unproved', async (code) => {
  const fn = vi.fn(async (url: string) => {
    const parsed = new URL(url);
    if (parsed.pathname === app) return status(404);
    expect(parsed.searchParams.get('org_slug')).toBe(cfg.org);
    return code === 200 ? Response.json({}) : status(code);
  });
  const host = flyHost(cfg, fn);
  const result = await host.retirementTarget(name);
  expect(result).toMatchObject({ ok: false });
  expect(result).not.toHaveProperty('missing', true);
  expect(fn).toHaveBeenCalledTimes(2);
});

test('foreign org stops before enumeration and mutation', async () => {
  const fn = vi.fn(async () => owner('other'));
  expect(await flyHost(cfg, fn).retirementTarget(name)).toMatchObject({ ok: false });
  expect(fn).toHaveBeenCalledTimes(1);
});

test.each([0, 1, 2])('a volume first observed in phase %i holds without destructive cleanup of that volume', async (phase) => {
  const known = disk('known', 'machine');
  const other = disk('unknown');
  let step = 0;
  let appExists = true;
  let disks = phase === 0 ? [known, other] : [known];
  const deletes: string[] = [];
  const host = flyHost(cfg, async (url, init) => {
    const path = new URL(url).pathname;
    if (init?.method === 'DELETE') {
      deletes.push(path);
      if (path === app) { appExists = false; disks = []; }
      else if (path === `${volumes}/known`) disks = disks.filter((d) => d.id !== 'known');
      else if (path === `${volumes}/unknown`) disks = disks.filter((d) => d.id !== 'unknown');
      return status(200);
    }
    if (path === app) return appExists ? owner() : status(404);
    if (path === '/v1/apps') return absent();
    if (path === volumes) return Response.json(disks);
    throw Error(path);
  });
  const target = await host.retirementTarget(name);
  if (!target.ok) throw Error(target.detail);
  if (phase === 1) disks.push(other);
  const retired = await host.retireWipedDisk(name, target.target);
  if (phase === 2 && retired.ok) {
    disks.push(other);
    const removed = await host.removeRetiredApp(name);
    step = removed.ok ? 2 : 0;
  } else step = retired.ok ? 1 : 0;
  expect({ step, deletes }).toEqual(phase === 2 ? { step: 0, deletes: [`${app}/machines/machine`, `${volumes}/known`] } : { step: 0, deletes: [] });
});

test('an already-removed disk can finish from the old persisted target format', async () => {
  const host = flyHost(cfg, async (url) => new URL(url).pathname === app ? owner() : Response.json([]));
  const old = { disk: 'known', machine: 'machine' };
  await expect(host.retireWipedDisk(name, old as never)).resolves.toEqual({ ok: true });
});

test('disappearance while wiping a located box is reconciled on the next alarm', async () => {
  let exists = true;
  const host = flyHost(cfg, async (url) => {
    const path = new URL(url).pathname;
    if (path === app) return exists ? owner() : status(404);
    if (path === '/v1/apps') return absent();
    if (path === volumes) return exists ? Response.json([disk('known', 'machine')]) : status(404);
    throw Error(path);
  });
  const box = fakeBox({ onlyFor: 'review-locate-wipe' });
  const c = await devChat('review-locate-wipe', {
    model: null, at: '2099-11-04T10:00',
    box: { ...box.deps, host, client: { ...box.deps.client, health: async () => { exists = false; return { kind: "unavailable", detail: "down" }; } } },
  });
  await c.say('hello');
  await env.LEDGER.prepare("INSERT INTO boxes (agent_key, name, host, created_at, deleted_at) VALUES (?, ?, 'fly', 1, NULL)").bind(c.agent, name).run();
  await c.say('/erase');
  const confirm = c.channel.delivered.at(-1)?.button;
  if (!confirm) throw Error('missing confirmation');
  await c.tap(confirm.data);
  c.clock.set((c.clock.now() + 60_000) as EpochMs);
  await c.settle();
  expect(c.channel.delivered.at(-1)?.text).toMatch(/box was removed earlier.*wipe/i);
});

test('legacy stuck jobs emit only age and a fixed diagnostic code once per day', async () => {
  const box = fakeBox({ onlyFor: 'review-hold-log' });
  const c = await devChat('review-hold-log', { model: null, at: '2099-11-04T10:00', box: box.deps });
  await c.say('hello');
  await env.LEDGER.prepare("INSERT INTO boxes (agent_key, name, host, created_at, deleted_at) VALUES (?, ?, 'static', 1, NULL)").bind(c.agent, name).run();
  await c.say('/erase');
  const confirm = c.channel.delivered.at(-1)?.button;
  if (!confirm) throw Error('missing confirmation');
  await c.tap(confirm.data);
  const stub = env.AGENT.get(env.AGENT.idFromName(c.agent));
  await runInDurableObject(stub, (_, { storage }) => {
    const { startedAt, diagnosedAt, ...legacy } = storage.kv.get<Record<string, unknown>>('account:erase')!;
    storage.kv.put('account:erase', legacy);
  });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    for (const hours of [24, 1, 24]) {
      c.clock.set((c.clock.now() + hours * 3_600_000) as EpochMs);
      await c.settle();
    }
    expect(warn.mock.calls.map(([line]) => line)).toEqual([
      { code: 'erase_box_host_mismatch', value: 24 }, { code: 'erase_box_host_mismatch', value: 49 },
    ]);
  } finally { warn.mockRestore(); }
});

test('a volume-list 404 after locate yields to the next alarm without spinning', async () => {
  let lists = 0;
  const host = flyHost(cfg, async (url) => {
    const path = new URL(url).pathname;
    if (path === app) return owner();
    if (path === volumes) {
      lists++;
      if (lists > 6) return status(500);
      return lists % 2 ? Response.json([]) : status(404);
    }
    throw Error(path);
  });
  const box = fakeBox({ onlyFor: 'review-locate-loop' });
  const c = await devChat('review-locate-loop', { model: null, at: '2099-11-04T10:00', box: { ...box.deps, host } });
  await c.say('hello');
  await env.LEDGER.prepare("INSERT INTO boxes (agent_key, name, host, created_at, deleted_at) VALUES (?, ?, 'fly', 1, NULL)").bind(c.agent, name).run();
  await c.say('/erase');
  const confirm = c.channel.delivered.at(-1)?.button;
  if (!confirm) throw Error('missing confirmation');
  await c.tap(confirm.data);
  expect(lists).toBe(2);
});

test('erase clears seeded old and new session rows and matches fresh SQLite, KV and alarms', async () => {
  const c = await devChat('review-both-sessions', { model: null, at: '2099-11-04T10:00' });
  const fresh = await devChat('review-fresh-account', { model: null, at: '2099-11-04T10:00' });
  const stub = env.AGENT.get(env.AGENT.idFromName(c.agent));
  const freshStub = env.AGENT.get(env.AGENT.idFromName(fresh.agent));
  await c.say('hello');
  await runInDurableObject(stub, (_, { storage }) => {
    storage.sql.exec("INSERT INTO box_session (one, id, seen_seq, memory, reply_backfill) VALUES (1, 'old-id', 3, 'old memory', '[\"old reply\"]')");
    storage.sql.exec("CREATE TABLE session (id TEXT, memory TEXT)");
    storage.sql.exec("INSERT INTO session VALUES ('new-id', 'new memory')");
  });
  const dataOf = (target: typeof stub) => runInDurableObject(target, async (_, { storage }) => ({
    tables: storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name NOT GLOB '__cf_*' ORDER BY name").toArray().map(({ name }) => [name, storage.sql.exec(`SELECT * FROM "${name}"`).toArray()]),
    keys: [...(await storage.list()).keys()],
    alarm: await storage.getAlarm(),
  }));
  await c.say('/erase');
  const confirm = c.channel.delivered.at(-1)?.button;
  if (!confirm) throw Error('missing confirmation');
  await fresh.tap(confirm.data);
  expect(fresh.channel.delivered).toEqual([]);
  await c.tap(confirm.data);
  expect(c.channel.delivered.at(-1)?.text).toMatch(/deleted your live Giraffe data/);
  expect(await dataOf(stub)).toEqual(await dataOf(freshStub));
});

test('new stuck erasures emit one non-content diagnostic in each 24-hour interval', async () => {
  const box = fakeBox({ onlyFor: 'review-new-hold-log' });
  const c = await devChat('review-new-hold-log', { model: null, at: '2099-11-04T10:00', box: box.deps });
  await c.say('hello');
  await env.LEDGER.prepare("INSERT INTO boxes (agent_key, name, host, created_at, deleted_at) VALUES (?, ?, 'static', 1, NULL)").bind(c.agent, name).run();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await c.say('/erase');
    const confirm = c.channel.delivered.at(-1)?.button;
    if (!confirm) throw Error('missing confirmation');
    await c.tap(confirm.data);
    for (const hours of [24, 1, 23]) {
      c.clock.set((c.clock.now() + hours * 3_600_000) as EpochMs);
      await c.settle();
    }
    expect(warn.mock.calls.map(([line]) => line)).toEqual([
      { code: 'erase_box_host_mismatch', value: 24 }, { code: 'erase_box_host_mismatch', value: 48 },
    ]);
  } finally { warn.mockRestore(); }
});
