import { join } from "node:path";
import { createBox } from "./server.ts";

const token = process.env.BOX_TOKEN;
if (!token) {
  console.error("BOX_TOKEN is required");
  process.exit(1);
}
delete process.env.BOX_TOKEN;

const port = Number(process.env.BOX_PORT ?? 8789);
const sessionFile = process.env.SESSION_FILE ?? join(process.env.HOME ?? ".", ".giraffe-session");
const server = createBox({ token, cli: [process.env.CLAUDE_BIN ?? "claude"], sessionFile });
server.listen(port, "0.0.0.0", () => console.log(`box on :${port}`));
process.on("SIGTERM", () => {
  server.close();
  server.closeAllConnections();
});
