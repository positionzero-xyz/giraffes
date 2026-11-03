# Box spike

One Linux box per person for "bring your own subscription". It runs the unmodified Claude Code CLI
signed in with the person's own plan, headless Chromium for browser tasks, and `app/dev/bridge.ts`
so the Durable Object can reach `claude -p` over HTTP. This directory proves the shape with a fake
model and measures it.

## Contents

- `Dockerfile` builds the box from the repository root: `docker build -f box/Dockerfile -t giraffes-box:spike .`
- `package.json` and `package-lock.json` pin Claude Code and zod. The lockfile is generated on Linux
  so npm sees the `libc` fields and installs only the glibc binary.
- `up.sh <name> <host-port> <work-dir>` starts a box with a fake API key, the mock Messages API inside
  it and every Anthropic host resolved to loopback.
- `mock-api.mjs` is the mock Messages API. It answers a `--json-schema` turn by calling
  `StructuredOutput` with an instance of the requested schema.
- `bench/` holds the measurement scripts. `turn.mjs` and `browser.mjs` run inside the box and
  `wake.mjs` and `summarize.mjs` run on the host.

## Pins

| Part | Version | Source |
| --- | --- | --- |
| Base image | `node:24-bookworm-slim@sha256:c86ecead…920c` (Node 24.22.2) | Docker Hub |
| Claude Code | 2.1.316, `sha512-i3BpzyDkcCPnsa0CSkWgxGPs7WMsyqDkxkqT0SDxyEC5XMIxEmcUmluWRHG9VSeBY8Vyv+l9X34JvJ/Bj54nBQ==` | npm `@anthropic-ai/claude-code` |
| Claude Code binary | 2.1.316, `sha512-RQDM6N285IjNKcmlPRriayNzpTkEJreAw5/vBU+V0R3qljkQ5z6/pSbzcVUAXvasoOlvub0RIma3NWvSuZA8Cg==` | npm `@anthropic-ai/claude-code-linux-x64` |
| Chromium | 156.0.8078.73-1~deb12u1 | Debian bookworm |

## Users

Claude Code and the bridge run as `agent` (uid 1001). `/home/agent`, `/home/agent/.claude`
(`CLAUDE_CONFIG_DIR`) and `/home/agent/brain` are mode 0700. Chromium runs as `browser` (uid 1002),
which gets `Permission denied` reading `/home/agent/.claude/.credentials.json`, listing
`/home/agent/brain` and reading `/proc/<bridge>/environ`. It can still read `/proc/<pid>/cmdline`,
which for a running `claude -p` holds the system prompt and schema. The person's messages go in on
stdin.

Docker's default seccomp profile blocks the user namespaces Chromium's sandbox needs, so `up.sh`
runs the box with `seccomp=unconfined`. A per-person VM would not need that.

## Measurements

Docker Desktop on the WSL2 kernel 6.18, 12 CPUs, 15.4 GiB, load average 0.0. The model is the
instant mock, so every time below is the CLI's own cost.

| What | Median | Range | Runs |
| --- | --- | --- | --- |
| `claude -p` peak tree PSS, 251-char prompt | 195 MiB | 192 to 196 MiB | 7 |
| `claude -p` peak tree PSS, 100,230-char prompt | 196 MiB | 194 to 197 MiB | 7 |
| Launch to first request at the mock | 222 ms | 216 to 250 ms | 7 per prompt size |
| Full bridge turn, small and large prompt | 282 and 288 ms | 265 to 405 ms | 7 per prompt size |
| `docker start` to bridge listening | 279 ms | 252 to 292 ms | 7 |
| First turn after that wake | 303 ms | 284 to 417 ms | 7 |
| Request bytes with `--tools ""` | 6,944 B | fixed | 7 |
| Request bytes without it (13 tools) | 45,359 B | fixed | 7 |
| Chromium tree PSS, chope.co Bangkok page | 527 MiB | 523 to 538 MiB | 5 |
| Chromium tree PSS, about:blank | 388 MiB | 387 to 389 MiB | 5 |
| Image | 1.81 GB on disk, 505 MB compressed | | |

Each turn makes exactly one Messages request, and every measured turn returned a schema-valid reply.
The CLI's startup limits turn time. It spends about 290 ms of CPU per turn (210 to 250 ms user,
60 to 90 ms system, 5 runs) over about 260 ms of wall time. Memory does not depend on prompt size.
The CLI is one process of about 200 MB resident, so PSS and RSS agree.

OpenTable refused every load with `net::ERR_HTTP2_PROTOCOL_ERROR`, and plain `curl` from the host
got 403. That is bot blocking, and the spike does not try to get around it. Chope never went 2
seconds without network traffic, so its PSS is sampled 15 seconds after the load event.

The image's largest layers are Chromium and its libraries (718 MB, of which `/usr/lib/chromium` is
348 MB), the Claude Code binary (314 MB) and Node (122 MB).
