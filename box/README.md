# Box

One small Linux machine per person for "bring your own subscription". It runs the unmodified Claude Code CLI signed in to the
person's own Claude account and answers the Worker over HTTP. The contract is
[`app/docs/design/BOX.md`](../app/docs/design/BOX.md).

## Contents

- `src/main.ts` starts the server on port 8789. It refuses to start without `BOX_TOKEN`, `HOME`, `CLAUDE_CONFIG_DIR` and
  `BOX_STATE_DIR`, because an erase empties the first two.
- `src/server.ts` serves `GET /health`, `POST /parse`, `POST /agent`, `POST /erase` and the sign-in routes. `src/erase.ts`
  holds what an erase removes and keeps, and the box's record of its erases. `src/auth.ts` checks the bearer token and
  sign-in tickets. `src/signin.html` is the page a person opens from the sign-in link.
- `src/claude.ts` runs one `claude -p` turn. `app/dev/bridge.ts` serves the same turn locally without auth.
- `Dockerfile` builds the image from this directory: `docker build -t giraffes-box:mvp box`. `entrypoint.sh` runs
  `lockdown.sh` as root, then drops to `agent` (uid 1001) and starts the server. `lockdown.sh` creates `/data/home` (`HOME`),
  `/data/claude` (`CLAUDE_CONFIG_DIR`) and `/data/box-state` (`BOX_STATE_DIR`) on the volume and hands them to `agent`. It
  then takes away `agent`'s write access everywhere else but `/tmp`, including the tmpfs mounts the host adds, and exits
  non-zero if any such place is left, so the box never writes where an erase doesn't reach.
- `up.sh <name> <host-port> <data-dir> [--mock [--script <script-file>]]` runs the image locally with `BOX_TOKEN` from the environment.
  `--mock` runs `mock-api.mjs` inside the box and signs the CLI in with a fake API key pointed at it, with every Anthropic host
  resolved to loopback, so `/parse` answers without a real model. A script file such as
  `{"calls":[{"name":"remember","input":{"note":"Lives in Chiang Mai."}}],"text":"Noted."}` seeds `mock-script.json` in a dump
  folder `up.sh` creates when needed, so tests can replace that copy while the box runs and make the mock call Giraffe's tools in
  order before its text answer; `MOCK_DUMPS=<host-dir>` chooses that folder and keeps the raw requests for inspection.
- `push.sh <fly-app>` builds for linux/amd64 and pushes `registry.fly.io/<fly-app>:<git short sha>`. It refuses when `box/`
  has uncommitted changes. Log docker in to `registry.fly.io` first.
- `npm test` runs `test/*.test.ts` against `test/fake-claude.mjs`, and `agent.test.ts` and `erase.test.ts` against the
  pinned CLI and `mock-api.mjs` on free ports chosen per run. It needs Node 24; the CLI tests skip until `npm ci` has run here.

`package.json` and `package-lock.json` pin Claude Code. The lockfile is generated on Linux so npm sees the `libc` fields and
installs only the glibc binary.

## Pins

| Part | Version | Source |
| --- | --- | --- |
| Base image | `node:24-bookworm-slim@sha256:c86ecead…920c` (Node 24.22.2) | Docker Hub |
| Claude Code | 2.1.316, `sha512-i3BpzyDkcCPnsa0CSkWgxGPs7WMsyqDkxkqT0SDxyEC5XMIxEmcUmluWRHG9VSeBY8Vyv+l9X34JvJ/Bj54nBQ==` | npm `@anthropic-ai/claude-code` |
| Claude Code binary | 2.1.316, `sha512-RQDM6N285IjNKcmlPRriayNzpTkEJreAw5/vBU+V0R3qljkQ5z6/pSbzcVUAXvasoOlvub0RIma3NWvSuZA8Cg==` | npm `@anthropic-ai/claude-code-linux-x64` |

The image is 830 MB on disk and 238 MB as a gzipped `docker save`. The Claude Code binary is 314 MB of that.

## Measurements

The spike in commit `0446308` measured the CLI with an instant mock model on Docker Desktop (WSL2, 12 CPUs). A `claude -p`
turn peaks at about 195 MiB whatever the prompt size, spends about 290 ms of CPU, and takes about 285 ms end to end through
the bridge. `docker start` to listening took about 280 ms. The scripts and the Chromium numbers are in that commit.
