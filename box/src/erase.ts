import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { diagnostic, errorCode } from "./diagnostics.ts";

export type PersonFiles = { readonly home: string; readonly configDir: string; readonly scratchDirs: readonly string[]; readonly sessionFile: string; readonly stateFile: string };

export type EraseState = {
  readonly box: string;
  readonly floor: number;
  readonly erasing: boolean;
  readonly epochs: boolean;
  readonly retired?: true;
};

const SIGN_IN = new Set([".credentials.json", ".claude.json"]);
const SIGN_IN_FIELDS = new Set(["oauthAccount"]);

export function writeDurably(file: string, text: string): void {
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
    typeof s.epochs === "boolean" &&
    (s.retired === undefined || s.retired === true)
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
const isRecord = (files: PersonFiles, name: string) => name === basename(files.stateFile) && lstatSync(files.stateFile).isFile();

// A process the erase just killed can hold a file open for a moment. On Windows Node 24 can return EPERM without waiting, so keep the bounded retry here.
const GONE = { recursive: true, force: true } as const;
const RETRYABLE = new Set(["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"]);
const RETRIES = 10;
const RETRY_DELAY = 100;
const retrySleep = new Int32Array(new SharedArrayBuffer(4));

function remove(path: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(path, GONE);
      return;
    } catch (err) {
      const error = errorCode(err);
      if (!RETRYABLE.has(error) || attempt === RETRIES) {
        diagnostic({ code: "erase_delete_failed", path, error });
        throw err;
      }
      Atomics.wait(retrySleep, 0, 0, (attempt + 1) * RETRY_DELAY);
    }
  }
}

const entries = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir) : []);

export function sessionFileFor(sessionFile: string, owner: string | undefined): string {
  return owner === undefined ? sessionFile : `${sessionFile}.${owner}`;
}

function sessionFiles(sessionFile: string): string[] {
  const base = basename(sessionFile);
  const keyed = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.[0-9a-f]{32}(?:\\.next)?$`);
  return entries(dirname(sessionFile))
    .filter((name) => name === base || name === `${base}.next` || keyed.test(name))
    .map((name) => join(dirname(sessionFile), name));
}

function emptyDir(dir: string, keep: (name: string) => boolean = () => false): void {
  for (const name of entries(dir)) if (!keep(name)) remove(join(dir, name));
}

export function sweep(files: PersonFiles, retired: boolean): void {
  for (const file of sessionFiles(files.sessionFile)) remove(file);
  emptyDir(files.configDir, (name) => !retired && isSignIn(files.configDir, name));
  const file = accountFile(files);
  if (existsSync(file)) {
    const account = readObject(file);
    if (account === null) remove(file);
    else if (extraFields(account).length > 0) writeDurably(file, JSON.stringify(Object.fromEntries(Object.entries(account).filter(([key]) => SIGN_IN_FIELDS.has(key)))));
  }
  emptyDir(files.home);
  for (const dir of files.scratchDirs) emptyDir(dir);
  emptyDir(dirname(files.stateFile), (name) => isRecord(files, name));
}

export function leftovers(files: PersonFiles, retired: boolean): string[] {
  const left = sessionFiles(files.sessionFile).filter(existsSync);
  left.push(...entries(files.configDir).filter((name) => retired || !isSignIn(files.configDir, name)).map((name) => join(files.configDir, name)));
  const file = accountFile(files);
  const account = existsSync(file) ? readObject(file) : {};
  if (account === null || extraFields(account).length > 0) left.push(file);
  for (const dir of [files.home, ...files.scratchDirs]) left.push(...entries(dir).map((name) => join(dir, name)));
  const stateDir = dirname(files.stateFile);
  left.push(...entries(stateDir).filter((name) => !isRecord(files, name)).map((name) => join(stateDir, name)));
  return left;
}
