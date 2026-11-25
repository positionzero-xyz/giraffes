# Model eval

Run the eval to compare models on Giraffe's Thai conversations, reminders, drafts, and small builds.

## Choose cases and preview the commands

Install the locked dependencies with `npm ci` in both `app/` and `box/`. Run these commands from `box/`.

```sh
node bench/model-eval/eval.ts --cases 1 --dry
node bench/model-eval/eval.ts --long --cases chat-long-resume,chat-switch-model --dry
```

A candidate is `model@effort`. The default control uses the Worker's model ID `claude-haiku-5-5` and omits the effort flag. The shared box code translates the ID to the Claude Code alias for product turns. The run records the IDs that the CLI reports. Use `--candidates` to set the matrix, `--cases` for a list of IDs or a count per shape, and `--reps` to repeat cases. Use `--now YYYY-MM-DDTHH:mm` to pin the Bangkok clock. The default is 10:00 today in Bangkok.

Chat and reminders use the box request builder, response decoder, and Worker planner. Drafts use the same turn path and grade the full draft. Builds have a separate file-writing contract and run in a fresh folder with file tools. Launch a live run by removing `--dry` and passing `--out <parent dir>`. It needs a signed-in CLI and, for builds, Chrome or Edge. The stated CLI times exclude LINE delivery.

`--long` enables the session cases. The history case seeds one box session for each selected candidate, then resumes after reported input and cache tokens reach 90,000. The switch case starts on Haiku and resumes the same session on Sonnet. The record keeps CLI wall time, cache reads, and cache writes for each stage.

## Grade a run

The summary reports deterministic results and quality results separately. Quality requires passing the deterministic checks and receiving yes on every case question from a calibrated `gemini-4-neon` judge. An optional second judge has its own column. Scores on outputs from the judge's own model family appear separately.

Give each judge only the `judge/` directory. It contains case-specific questions and random IDs. Keep the key, expected planted answers, model IDs, and quarantine file outside that hand-off.

```sh
node bench/model-eval/eval.ts score --run <run dir> --judge gemini-4-neon --scores <file.json>
```

The score file must fill the template with JSON booleans. The judge must match the labelled planted answers and rank the three calibration drafts in order. An uncalibrated judge's scores are excluded from candidate results.

To add held-out items, pass `--calibration <file.json>` on a run or regrade. The file is an array of objects with `id`, `caseId`, `reply`, and `expected`. The last field maps one or more question keys from `cases.ts` to booleans. Use `html` for builds. Reminder items can include `now`, `message`, `wakeups`, `notes`, and `cancelled` as evidence.

## Regrade saved results

```sh
node bench/model-eval/eval.ts regrade --run <run dir> --out <new dir>
```

Regrading reads saved model output, Worker commits, and build files without calling a model. It writes a new result and a new judge batch. Older runs may contain only reply text and calls. The summary identifies reconstructed and missing evidence. Missing checks remain pending. Run `npm test` in `box/` to verify the graders, including the headless browser fixtures.
