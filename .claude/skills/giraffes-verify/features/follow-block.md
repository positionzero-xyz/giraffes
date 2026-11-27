# Follow and block

Adding the agent gets a greeting from the model. Blocking it stops wake-ups and unasked messages to that person until they write again.

## Sub-features

- `life-follow` greets when the person has model access. The `daily-checkin` at 09:00 local is scheduled at first contact, whatever the first event is.
- `life-block` marks the person blocked without a model call.
- `life-return` sets a blocked person back to `active` when they send a message.
- `life-skipped` skips any wake-up that comes due while the person is blocked.

## How to get to it (user POV)

- Send `/follow` or `/block` on the dev channel or the chat page.

## Driving it with gv

Preconditions:

- Bridge backend, or scripted with `/dev/script`, for `life-follow` and `life-return`. `life-block` and `life-skipped` work on plain scripted.
- User `life1` has no history.

- **Follow.** On scripted, post a script with two `send` entries for `life1` first. Run `$GV say life1 /follow`, then `$GV wait life1 's.outbox.some(o => o.status === "sent")' 90`. `agent.status` is `active`, one sent `reply` row holds the greeting, and `pendingWakeups` has `daily-checkin` with `dueAt` at the next 09:00 in the person's zone. Without access (`mvp/model-access`, no script) `/follow` gets the "connect your AI" offer, the `lifecycle` turn ends `no_access`, and a message later that day gets no second offer.
- **Block.** Run `$GV say life1 /block`, then `$GV wait life1 's.agent.status === "blocked"' 20`. `$GV ledger "SELECT event_kind, outcome FROM turn_log WHERE agent_key='p:dev:life1'"` has a `lifecycle` row with outcome `no_model`, and `$GV ledger "SELECT change, source FROM lifecycle WHERE agent_key='p:dev:life1'"` has `block` from `channel`.
- **Return.** Run `$GV say life1 "are you there"`. The reply is delivered, `agent.status` goes back to `active`, and the `lifecycle` table gains a `follow` row from `channel`.
- **Skipped while blocked.** Give a fresh user a reminder 2 minutes out (see [reminders](./reminders.md)), send `/block`, and wait past the due time without sending anything. `$GV dosql <user> "SELECT key, status FROM wakeup"` shows the reminder `skipped`, and no `requested` outbox row appears.

## Gotchas

- A message from a blocked person reactivates them, so any `say` ends the block. Prove skipping with a wake-up that fires on the real alarm, not with `advance` plus `say`.
- `daily-checkin` stays in `pendingWakeups` after a block. It is skipped, not cancelled, when it comes due.
