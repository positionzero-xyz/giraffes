# Box

One small Linux machine per person for "bring your own subscription". It runs the unmodified Claude Code CLI signed in to the
person's own Claude account and answers the Worker over HTTP. The contract is
[`app/docs/design/BOX.md`](../app/docs/design/BOX.md).

## Contents

- `src/main.ts` starts the server on port 8789. It refuses to start without `BOX_TOKEN`.
- `src/server.ts` serves `GET /health`, `POST /parse` and the sign-in routes. `src/auth.ts` checks the bearer token and
  sign-in tickets. `src/signin.html` is the page a person opens from the sign-in link.
- `src/claude.ts` runs one `claude -p` turn. `app/dev/bridge.ts` serves the same turn locally without auth.
- `Dockerfile` builds the image from this directory: `docker build -t giraffes-box:mvp box`. `entrypoint.sh` creates
  `/data/home` (`HOME`) and `/data/claude` (`CLAUDE_CONFIG_DIR`) on the volume, hands them to `agent` (uid 1001) and drops
  to that user before starting the server.
- `up.sh <name> <host-port> <data-dir> [--mock]` runs the image locally with `BOX_TOKEN` from the environment. `--mock`
  runs `mock-api.mjs` inside the box and signs the CLI in with a fake API key pointed at it, with every Anthropic host
  resolved to loopback, so `/parse` answers without a real model.
- `push.sh <fly-app>` builds for linux/amd64 and pushes `registry.fly.io/<fly-app>:<git short sha>`. It refuses when `box/`
  has uncommitted changes. Log docker in to `registry.fly.io` first.
- `npm test` runs `test/*.test.ts` against `test/fake-claude.mjs`. It needs Node 24 and nothing installed.

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
