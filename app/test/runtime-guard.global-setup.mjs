const uncaught = [];
const patched = [];

function watch(stream) {
  const original = stream.write.bind(stream);
  let pending = "";
  stream.write = function patchedWrite(chunk, encoding, callback) {
    const lines = (pending + String(chunk)).split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) if (line.includes("uncaught exception")) uncaught.push(line);
    return original(chunk, encoding, callback);
  };
  patched.push({
    flush() {
      if (pending.includes("uncaught exception")) uncaught.push(pending);
      pending = "";
    },
    restore() {
      stream.write = original;
    },
  });
}

export function setup() {
  watch(process.stderr);
  watch(process.stdout);
  return function teardown() {
    for (const patch of patched.splice(0)) {
      patch.flush();
      patch.restore();
    }
    if (uncaught.length === 0) return;
    // Vitest reports a global-teardown exception as "error during close" but still exits 0, so the guard must own the exit status.
    process.stderr.write(`Workers runtime emitted ${uncaught.length} uncaught exception line(s); failing the suite.\n`);
    process.exitCode = 1;
  };
}
