# Model eval

This harness measures how well a model and effort level do Giraffe's own jobs in Thai. It runs each case through the same path a person's text takes, or through the planned contract for jobs the product doesn't ship yet, and grades the result.

## Shapes

| Shape | Cases | Runs through | Deterministic checks (`checks.ts`) | Judged |
| --- | --- | --- | --- | --- |
| `chat` | 4 | `agentTurn`, fed what `#boxAgent` sends, then `planTurn` | `thai`, `no_jargon`, `mentions`, `fits_reply`, `worker_accepts` | yes |
| `reminder` | 6 | the same, with "now" at 10:00 Bangkok | `due_at` (with `repeat`), or `asks_or_assumes` for a vague time, plus the chat checks except `mentions` | no |
| `draft` | 4 | the same turn; the checks read the full reply, and `overReplyCap` records whether the Worker would cut it | `thai`, `length`, `facts` | yes |
| `build` | 3 | a separate `claude -p` in an empty folder, file tools only | `file`, `html_complete`, `page_has`, `loads_clean`, and `persists` for the two interactive pages | yes |

For Claude candidates, chat and reminder are the product path. Draft and build are a planned contract: the product doesn't ship them yet. Giraffe has no Codex path, so every Codex shape is a planned contract.

"Now" is today at 10:00 Asia/Bangkok, because the CLI also puts the machine's date in its system prompt. `--now` pins it, and every record whose date differs from the machine's is flagged.

## Run

Run from `box/` with a signed-in CLI. The pinned box CLI is the default, and it uses your local login.

```sh
npm ci                      # in box/ and in app/
node bench/model-eval/eval.ts --candidates haiku@low,haiku@medium --cases 1 --dry
node bench/model-eval/eval.ts --candidates haiku@low,haiku@medium --cases 1 --out <dir>
```

A candidate is `model@effort`, where effort is `default` (no flag, so the CLI picks) or one of `low`, `medium`, `high`, `xhigh`, `max`. With no `--candidates`, the first-run matrix of eight Claude candidates runs. A Codex candidate is `codex:model@effort`, with effort `default`, `low`, `medium`, `high` or `xhigh` (see below). `--cases` takes case ids or a count per shape, and `--reps` repeats each case.

Each run writes `run.json` (one record per case, candidate and rep), `summary.md`, the timing taps, each build's files, and a judge batch.

## Codex

A Codex candidate such as `codex:gpt-6.2-sol@low` runs `codex --profile pool exec -m <model> -c model_reasoning_effort="<effort>" --json`, always on the `pool` profile. It runs in its own Codex home, built for the run from your `pool` profile and the provider it names. The provider's bearer token moves from the config into an environment variable, so it never reaches argv, `--dry` output or a record. The home holds no `auth.json`, so a run can't fall back to a personal ChatGPT seat. Because the home is fresh, and `USERPROFILE` and `HOME` point at an empty folder, your `AGENTS.md`, skills and plugins stay out.

- Chat, reminder and draft get the same request the Claude box turn gets: its appended system text as `developer_instructions`, its turn on stdin, and its tools through the box's own tool server (`box/src/giraffe-mcp.ts`), attached as the MCP server `giraffe` and exposed as direct tools. The reply then goes through `readTurn`, the same as a Claude turn, and each shape is graded the same way as Claude's. The sandbox is read-only, in an empty temp folder, with a 119 s limit.
- Build gets the build system text in an empty temp folder, with the `workspace-write` sandbox, no network and a 300 s limit. On Windows the build home sets `[windows] sandbox = "unelevated"`. Without a mode, Codex runs `workspace-write` as read-only. The `elevated` mode keeps its setup and sandbox-user secrets in your own Codex home, so a fresh home would have to set it up again.

Codex can't be limited to Giraffe's tools alone. It still offers Code Mode's `exec` (with `apply_patch`, MCP resource readers, `view_image` and a clock inside), `wait`, and its ask-the-user and message-the-user tools. Shell, web search, skills, subagents, plugins and the rest are off. Before spending anything, each run reads the tool list and the sandbox's write access from Codex's first request to a local plain-HTTP server. That server refuses Codex's model catalog request, so a real run could see a different catalog and tools. The run puts the list in `run.json` and the summary, and it stops if that request never arrives or a build couldn't write its folder. `otherTools` on a record names any other tool that shows up in Codex's events, such as `file_change` for a build's edits. A Code Mode call shows up only through what it did, so a patch the sandbox refused leaves no event.

Codex reports tokens but no cost, so `costUsd` is null and the summary shows its cost as unknown. Token columns use Claude's meaning: in is the uncached input, cache read is Codex's cached input, and out includes reasoning. A usage-limit error records `usage_limit`, and any other failed turn records `codex_failed`. Codex's raw events for each run are saved next to its tap as `<id>.codex.jsonl`.

## Judges

`judge/` holds a shuffled batch under random ids, with three hand-written calibration drafts mixed in. `judge-key.json` maps ids back to runs and sits outside `judge/`, so give judges only that folder. Ingest each judge's scores, then read the rebuilt summary:

```sh
node bench/model-eval/eval.ts score --run <run dir> --judge <name> --scores <file.json>
```

A judge counts only if it scores the calibration drafts good above flat above bad. Otherwise the summary marks it unproven.

## Tests

`npm test` in `box/` proves every check on a known-good and a known-bad fixture, the answer keys at pinned dates, the timing tap's timeout, the browser driver on two page styles, and the judge gate both ways. For Codex it proves the arguments, the isolated home and its key handling, the tool server attachment, and the JSONL reader on a recorded turn, a failed turn and a usage-limit error.
