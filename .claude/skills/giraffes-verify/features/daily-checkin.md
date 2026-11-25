# Daily check-in

Once a day at 09:00 in the person's zone the agent wakes up on its own and texts the person only when it has something useful to say.

## Sub-features

- `chk-fire` runs a `checkin` turn and reschedules `daily-checkin` for the next day.
- `chk-send` delivers an `unasked` message when the agent chooses to speak.
- `chk-quiet` records a quiet turn when it has nothing to say.
- `chk-limits` defers check-ins and unasked messages in quiet hours and stops after 3 unasked messages per local day.

## How to get to it (user POV)

- Write to the agent once, then wait for 09:00 local. Locally, shortcut the clock with `advance`.

## Driving it with gv

Preconditions:

- Bridge backend, or scripted with `/dev/script`. User `chk1` has written once, so `daily-checkin` is pending.
- It is between 08:00 and 22:00 in the person's zone. During Bangkok's night, have the first scripted turn send `{"type":"set_locale","timeZone":"Europe/London","language":"en"}` (or any zone where it is daytime). The check-in moves to 09:00 there.

- **Fire (test-only clock).** On scripted, post enough entries for the next message and the check-in (each consumes one). Run `$GV advance chk1 daily-checkin`, then `$GV say chk1 ping`. The message is answered first, then the check-in runs. Run `$GV wait chk1 's.pendingWakeups.some(w => w.key === "daily-checkin" && w.dueAt > Date.now() + 3600e3)' 90` to see it rescheduled for tomorrow. `$GV ledger "SELECT event_kind, outcome FROM turn_log WHERE agent_key='p:dev:chk1'"` has a `checkin` row.
- **Quiet or send.** That row's outcome is `quiet` when the agent had nothing to say (scripted: `{"type":"quiet"}`), `acted` with a new outbox row of intent `unasked` via `push`, or `no_access` with no text when the person has no model. For a send, `$GV ledger "SELECT trigger_kind, status, day, purpose FROM unasked_message WHERE agent_key='p:dev:chk1'"` reads `checkin`, `sent`, today, and `unlinked` when it follows no task.
- **Limits.** `unaskedSentToday` in the snapshot counts admitted unasked messages against the cap of 3, and a message over the cap is recorded `dropped_budget`. In quiet hours an `advance`d check-in stays pending with its old `dueAt` until 08:00 local.

## Gotchas

- Without an earlier conversation the agent usually chooses quiet. A quiet check-in is a pass for `chk-fire`.
- `advance` is the only local way to reach the check-in short of waiting until 09:00. Say so in the proof.
