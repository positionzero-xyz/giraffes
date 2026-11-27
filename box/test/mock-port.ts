import type { ChildProcess } from "node:child_process";

/** Reads the port mock-api chose, which lets every test run ask the OS for a free one. */
export function mockPort(mock: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let out = "";
    mock.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      const port = out.match(/mock on (\d+)/)?.[1];
      if (port !== undefined) resolve(Number(port));
    });
    mock.once("error", reject);
    mock.once("exit", (code) => reject(new Error(`mock exited ${code} before listening`)));
  });
}
