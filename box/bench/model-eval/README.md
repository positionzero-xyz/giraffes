# Model eval

This harness measures how well a model and effort level do Giraffe's own jobs in Thai. It runs each case through the same path a person's text takes, or through the planned contract for jobs the product doesn't ship yet, and grades the result.

## Shapes

| Shape | Cases | Runs through | Deterministic checks (`checks.ts`) | Judged |
| --- | --- | --- | --- | --- |
| `chat` | 4 | `agentTurn`, fed what `#boxAgent` sends, then `planTurn` | `thai`, `no_jargon`, `mentions`, `fits_reply`, `worker_accepts` | yes |
| `reminder` | 6 | the same, with "now" at 10:00 Bangkok | `due_at` (with `repeat`), or `asks_or_assumes` for a vague time, plus the chat checks except `mentions` | no |
| `draft` | 4 | the same turn; the checks read the full reply, and `overReplyCap` records whether the Worker would cut it | `thai`, `length`, `facts` | yes |
| `build` | 3 | a separate `claude -p` in an empty folder, file tools only | `file`, `html_complete`, `page_has`, `loads_clean`, and `persists` for the two interactive pages | yes |

Chat and reminder are the product path. Draft and build are a planned contract: the product doesn't ship them yet.

"Now" is today at 10:00 Asia/Bangkok, because the CLI also puts the machine's date in its system prompt. `--now` pins it, and every record whose date differs from the machine's is flagged.

## Run

Run from `box/` with a signed-in CLI. The pinned box CLI is the default, and it uses your local login.

```sh
npm ci                      # in box/ and in app/
node bench/model-eval/eval.ts --candidates haiku@low,haiku@medium --cases 1 --dry
node bench/model-eval/eval.ts --candidates haiku@low,haiku@medium --cases 1 --out <dir>
```

A candidate is `model@effort`, where effort is `default` (no flag, so the CLI picks) or one of `low`, `medium`, `high`, `xhigh`, `max`. With no `--candidates`, the first-run matrix of eight Claude candidates runs. `--cases` takes case ids or a count per shape, and `--reps` repeats each case.

Each run writes `run.json` (one record per case, candidate and rep), `summary.md`, the timing taps, each build's files, and a judge batch.

## Judges

`judge/` holds a shuffled batch under random ids, with three hand-written calibration drafts mixed in. `judge-key.json` maps ids back to runs and sits outside `judge/`, so give judges only that folder. Ingest each judge's scores, then read the rebuilt summary:

```sh
node bench/model-eval/eval.ts score --run <run dir> --judge <name> --scores <file.json>
```

A judge counts only if it scores the calibration drafts good above flat above bad. Otherwise the summary marks it unproven.

## Tests

`npm test` in `box/` proves every check on a known-good and a known-bad fixture, the answer keys at pinned dates, the timing tap's timeout, the browser driver on two page styles, and the judge gate both ways.
