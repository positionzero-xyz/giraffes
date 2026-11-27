# giraffes verification map

The maintained source for verifying what a person texting the agent can observe. Read this index, then use the matching feature file as the recipe. Commands assume `GV` and `RUN_DIR` from `../SKILL.md`.

## Baseline preconditions

- A `RUN_DIR` prepared and launched per `../SKILL.md`, with `$GV doctor` all `ok`.
- The backend each recipe names. Most need `bridge`. A scripted run proves only the paths marked scripted.
- A fresh user name per recipe, so earlier turns, reminders and spend do not leak in.

## Driving conventions

- Act through `$GV say` or the dev chat page. Observe through `$GV snapshot`, `$GV wait` and `$GV ledger`.
- Assert on outbox `intent`, `status` and `via`, wake-up keys and due times, and ledger outcomes. Model wording varies between runs.
- Code-written notices are different: their fixed text promises what happens next. Read each one and check that the next outbox rows keep the promise. Every entry event, a first message or a `/follow`, ends in a sent row or in a silence these docs describe.
- `$GV advance` and `$GV dosql` writes shortcut the clock or state. Name them in the proof when used.

## Proof and skip reporting

- Save a snapshot after each step with `$GV snapshot <user> <feature>-<step>`, and ledger output to `evidence/`.
- Report the backend. Report an unreachable path with the command tried and the unmet precondition.
- Do not report a path as verified through a different entry point.
- Before writing a "before X" or "on X and later" note, check it with `git show <branch>:<path>` against every branch it names. Prefer a marker the reader can see at run time, such as "when the snapshot has `access`", to a branch name.

## Features

- [Conversation](./conversation.md) covers messages, replies, batching, the model-failure reply and the chat page.
- [Follow and block](./follow-block.md) covers the greeting, check-in scheduling, a blocked person writing again, and wake-ups skipped while blocked.
- [Reminders](./reminders.md) covers asking for, firing, cancelling and late reminders.
- [Daily check-in](./daily-checkin.md) covers the system wake-up, quiet hours and the unasked budget.
- [Ledger and spend](./ledger-spend.md) covers turn, model-call and lifecycle rows and the monthly spend.
- [Box](./box.md) covers `/claude`, the sign-in link, turns through a person's box, and what a signed-out box does.
- [Model access](./model-access.md) covers no access, the `/key` page, pasted-key redaction, missing usage, a hung provider and long Thai on the smallest budget (mvp/model-access and later).
