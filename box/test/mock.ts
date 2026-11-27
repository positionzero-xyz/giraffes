import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

const MOCK = fileURLToPath(new URL("../mock-api.mjs", import.meta.url));

export type RunningMock = { readonly proc: ChildProcessWithoutNullStreams; readonly port: number };

/** Starts the mock Messages API on a free loopback port, or fails instead of hanging the test hook. */
export function startMock(log: string, dumps: string, script: string): Promise<RunningMock> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [MOCK, log, "0", dumps, script], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error, port?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        proc.kill();
        reject(error);
      } else {
        resolve({ proc, port: port ?? 0 });
      }
    };
    const timer = setTimeout(() => finish(new Error("the mock Messages API did not start within 10s")), 10_000);
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const port = /mock on (\d+)/.exec(stdout)?.[1];
      if (port !== undefined) finish(undefined, Number(port));
    });
    proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    proc.once("error", (err) => finish(err));
    proc.once("exit", (code, signal) => finish(new Error(`the mock Messages API exited before listening (${signal ?? code}): ${stderr.trim()}`)));
  });
}
