import { createBox } from "./server.ts";

const token = process.env.BOX_TOKEN;
if (!token) {
  console.error("BOX_TOKEN is required");
  process.exit(1);
}
delete process.env.BOX_TOKEN;

const port = Number(process.env.BOX_PORT ?? 8789);
const server = createBox({ token, cli: [process.env.CLAUDE_BIN ?? "claude"] });
server.listen(port, "0.0.0.0", () => console.log(`box on :${port}`));
process.on("SIGTERM", () => {
  server.close();
  server.closeAllConnections();
});
