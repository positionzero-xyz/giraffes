import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBox } from "./server.ts";

const token = process.env.BOX_TOKEN;
if (!token) {
  console.error("BOX_TOKEN is required");
  process.exit(1);
}
delete process.env.BOX_TOKEN;

const { HOME: home, CLAUDE_CONFIG_DIR: configDir, BOX_STATE_DIR: stateDir } = process.env;
if (!home || !configDir || !stateDir) {
  console.error("HOME, CLAUDE_CONFIG_DIR and BOX_STATE_DIR are required: an erase empties HOME and CLAUDE_CONFIG_DIR, and records itself in BOX_STATE_DIR");
  process.exit(1);
}
delete process.env.BOX_STATE_DIR;

const LOCKED_SCRATCH = ["/var/tmp", "/run/lock", "/dev/shm", "/dev/mqueue"];
const port = Number(process.env.BOX_PORT ?? 8789);
const sessionFile = process.env.SESSION_FILE ?? join(home, ".giraffe-session");
const server = createBox({ token, cli: [process.env.CLAUDE_BIN ?? "claude"], sessionFile, home, configDir, scratchDirs: [tmpdir(), ...LOCKED_SCRATCH], stateFile: join(stateDir, "erase.json"), requireEpoch: process.env.BOX_REQUIRE_EPOCH === "1" });
server.listen(port, "0.0.0.0", () => console.log(`box on :${port}`));
process.on("SIGTERM", () => {
  server.close();
  server.closeAllConnections();
});
