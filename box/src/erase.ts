import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

export type PersonFiles = { readonly home: string; readonly configDir: string; readonly scratchDirs: readonly string[]; readonly sessionFile: string };

export type EraseState = { readonly box: string; readonly floor: number; readonly erasing: boolean; readonly epochs: boolean };

const SIGN_IN = new Set([".credentials.json", ".claude.json"]);
const SIGN_IN_FIELDS = new Set(["oauthAccount"]);

function writeDurably(file: string, text: string): void {
  const next = `${file}.next`;
  const fd = openSync(next, "w", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(next, file);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isState(v: unknown): v is EraseState {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.box === "string" &&
    UUID.test(s.box) &&
    Number.isSafeInteger(s.floor) &&
    (s.floor as number) >= 0 &&
    typeof s.erasing === "boolean" &&
    typeof s.epochs === "boolean"
  );
}

export const saveState = (file: string, state: EraseState): void => writeDurably(file, JSON.stringify(state));

export function loadOrCreateState(file: string): EraseState {
  if (!existsSync(file)) {
    const fresh = { box: randomUUID(), floor: 0, erasing: false, epochs: false };
    saveState(file, fresh);
    return fresh;
  }
  const state: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isState(state)) throw new Error(`unreadable erase state in ${file}`);
  return state;
}

function readObject(file: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const accountFile = (files: PersonFiles) => join(files.configDir, ".claude.json");
const extraFields = (account: Record<string, unknown>) => Object.keys(account).filter((key) => !SIGN_IN_FIELDS.has(key));
const isSignIn = (dir: string, name: string) => SIGN_IN.has(name) && lstatSync(join(dir, name)).isFile();

// A process the erase just killed can hold a file open for a moment, which makes a delete fail on Windows.
const GONE = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 } as const;

const entries = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir) : []);

function emptyDir(dir: string, keep: (name: string) => boolean = () => false): void {
  for (const name of entries(dir)) if (!keep(name)) rmSync(join(dir, name), GONE);
}

export function sweep(files: PersonFiles): void {
  rmSync(files.sessionFile, GONE);
  emptyDir(files.configDir, (name) => isSignIn(files.configDir, name));
  const file = accountFile(files);
  if (existsSync(file)) {
    const account = readObject(file);
    if (account === null) rmSync(file, GONE);
    else if (extraFields(account).length > 0) writeDurably(file, JSON.stringify(Object.fromEntries(Object.entries(account).filter(([key]) => SIGN_IN_FIELDS.has(key)))));
  }
  emptyDir(files.home);
  for (const dir of files.scratchDirs) emptyDir(dir);
}

export function leftovers(files: PersonFiles): string[] {
  const left = existsSync(files.sessionFile) ? [files.sessionFile] : [];
  left.push(...entries(files.configDir).filter((name) => !isSignIn(files.configDir, name)).map((name) => join(files.configDir, name)));
  const file = accountFile(files);
  const account = existsSync(file) ? readObject(file) : {};
  if (account === null || extraFields(account).length > 0) left.push(file);
  for (const dir of [files.home, ...files.scratchDirs]) left.push(...entries(dir).map((name) => join(dir, name)));
  return left;
}
