import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "./browser.ts";
import type { Check, PageDrive, Tap } from "./types.ts";

export function readTap(file: string): Tap | null {
  if (!existsSync(file)) return null;
  const rows = readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Tap & { args?: string[] });
  return rows.findLast((row) => row.args?.[0] === "-p") ?? rows[0] ?? null;
}

function driveFor(checks: readonly Check[]): PageDrive | null {
  if (checks.some((c) => c.kind === "order_flow")) return "order";
  const form = checks.find((c) => c.kind === "persists");
  return form?.kind === "persists" ? form.drive : null;
}

export async function buildEvidence(chrome: string | null, dir: string, checks: readonly Check[]) {
  const index = join(dir, "index.html");
  const files: Record<string, string> = existsSync(index) ? { "index.html": readFileSync(index, "utf8") } : {};
  const page = chrome && files["index.html"]?.trim() ? await inspect(chrome, index, driveFor(checks)) : null;
  return { files, page };
}

export function readJson(dir: string, name: string): unknown {
  return JSON.parse(readFileSync(join(dir, name), "utf8"));
}

export function scoreNames(dir: string): string[] {
  const scores = join(dir, "scores");
  return existsSync(scores) ? readdirSync(scores).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)) : [];
}
