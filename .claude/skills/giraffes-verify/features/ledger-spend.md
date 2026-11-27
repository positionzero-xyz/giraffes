# Ledger and spend

Every turn, model call, unasked message and follow or block lands in the D1 ledger that the operator's gate queries read. Each person's monthly spend is tracked in the agent.

## Sub-features

- `led-turns` writes one `turn_log` row per turn with event kind and outcome.
- `led-calls` writes a `model_call` row with backend, status and cost for each model call.
- `led-lifecycle` writes `lifecycle` rows for follow and block.
- `led-spend` shows the month's spend in the snapshot and the chat page header.

## How to get to it (user POV)

- Operator-facing. Reached by running any conversation, then querying the ledger.

## Driving it with gv

Preconditions:

- Bridge, or scripted with `/dev/script`, for non-zero `led-calls` and `led-spend`. An unscripted person on `mvp/model-access` makes no model call.
- One user who has had at least one model turn, here `led1`.

- **Turns.** Run `$GV ledger "SELECT event_kind, outcome, batch_size, cost_micro, attempts FROM turn_log WHERE agent_key='p:dev:led1' ORDER BY finished_at" > $RUN_DIR/evidence/led1-turns.json`. One row per turn, in order. Outcomes include `acted`, `quiet`, `no_access`, `no_model`, `poison` and `model_failed`.
- **Model calls.** Run `$GV ledger "SELECT purpose, backend, model, status, estimate_micro, cost_micro FROM model_call WHERE agent_key='p:dev:led1' ORDER BY at"`. A bridge or scripted turn shows `turn`, `included`, `bridge:claude-haiku-5-5`, `settled`. A key shows `key` and `<provider>:<model>`, a box `box`, `claude-plan:<model>` and cost 0. `main` has no `backend` column (it arrives with `mvp/byos`), and before `mvp/model-access` a bridge call reads `api`. Other statuses are `in_doubt` and `usage_missing` (charged at the estimate), and `rejected`.
- **Lifecycle.** Run `$GV ledger "SELECT change, source FROM lifecycle WHERE agent_key='p:dev:led1'"` after a `/follow` or `/block`.
- **Spend.** `spendThisMonthMicro` in `$GV snapshot led1` equals `$GV ledger "SELECT sum(cost_micro) FROM model_call WHERE agent_key='p:dev:led1'"` for the month. On `mvp/model-access` it is the sum of `access.spentMicro.byok` and `.included`, so a person's own key spend counts too.
- **Gate views.** `$GV ledger "SELECT * FROM gate_summary"` runs every gate over local data (from `mvp/measure`; earlier branches have `gate_weekly_delegation` instead). Dev people are staff, not enrolled beta testers, so the gates read 0 here. That proves the views run, not that they count right.

## Gotchas

- Log rows ship on the next drain flush. Query after `wait` returns, not right after `say`.
- `prepare` must have loaded the schema, or the flush fails and no ledger rows appear. Before `mvp/model-access`, the first model call also can't get a spend lease, and the turn ends `model_failed` after retries.
