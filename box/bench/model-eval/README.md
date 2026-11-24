# Model eval

This harness measures how well a model and effort level do Giraffe's own jobs in Thai. It runs each case through the same path a person's text takes, or through the planned contract for jobs the product doesn't ship yet, and grades the result.

## Shapes

| Shape | Path | What is graded |
| --- | --- | --- |
| `chat` | Product: the box's `agentTurn` with the Worker's appended prompt, tools and turn prompt | Thai reply, no internal jargon, answers the question, fits the 600-character reply, the Worker accepts it. A judge scores helpfulness and natural Thai. |
| `reminder` | Product, as above, then the Worker's `planTurn` | The reminder's local time (and repeat) equals the expected value. A vague time passes only if the reply asks back or names the time it picked. |
| `draft` | Planned: the same turn path, graded on the full reply before the Worker's 600-character cut | Every given fact present, mostly Thai, length in range. A judge scores natural Thai, persuasion and fit to the channel. |
| `build` | Planned: `claude -p` in an empty temp folder with only Read, Write and Edit, 300 s limit | `index.html` exists and is whole, holds the required items, loads in headless Chrome or Edge with no errors, and for the two interactive cases keeps an entry after a reload. A judge scores whether the owner would use it. |

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
