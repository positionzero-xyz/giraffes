# Reminders

A person asks to be reminded at a time, the agent confirms, and the reminder arrives as its own message at that time.

## Sub-features

- `rem-set` schedules a person-asked wake-up and confirms it.
- `rem-fire` delivers the reminder at its due time as intent `requested` via `push`.
- `rem-floor` sends the code-written `Reminder: <note>` when the model sends nothing at firing time or isn't available.
- `rem-cancel` removes a pending reminder on request.
- `rem-late` prefixes a late notice when a wake-up fires more than an hour after it was due.
- `rem-routine` (from 14b4558) repeats a person-asked reminder daily, on weekdays or weekly. Code schedules each next occurrence when one fires; cancelling the key ends it.

## How to get to it (user POV)

- Ask in a message, for example "remind me in 2 minutes to drink water", or "cancel that reminder".

## Driving it with gv

Preconditions:

- Bridge backend, or scripted with `/dev/script` (`mvp/fix-core` and later).
- User `rem1` has no history.

- **Set.** On bridge, run `$GV say rem1 "Please remind me in 2 minutes to drink water"`. On scripted, first post a turn with `{"type":"schedule_wakeup","key":"water","at":"<local YYYY-MM-DDTHH:mm, 2+ minutes out>","note":"drink water","asked":true,"task":""}` and a `send`, then `say`. Compute `at` in the person's zone, for example `node -e 'console.log(new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Bangkok",dateStyle:"short",timeStyle:"short"}).format(Date.now()+150e3).replace(" ","T"))'`. Then `$GV wait rem1 's.pendingWakeups.some(w => w.kind === "reminder")' 90`. The wake-up has `origin: "person"` and `dueAt` at that minute. The confirmation is whatever the model sent; code adds none.
- **Fire.** Run `$GV wait rem1 's.outbox.some(o => o.intent === "requested" && o.status === "sent")' 240`. The outbox row is `via: "push"` and the reminder is gone from `pendingWakeups`. The ledger has a `wakeup` row in `turn_log`. This path uses the real Durable Object alarm. On scripted the object is usually evicted before the alarm, so the script is gone, the wake-up turn ends `no_access`, and the text is the code floor `Reminder: drink water`. That proves `rem-fire` and `rem-floor` together.
- **Routine.** On bridge, `$GV say rut1 "Every weekday at 8 am ask me for my top task"`. Wait for a pending reminder with `repeat.every === "weekdays"` and `repeat.anchor` at 08:00 on the next weekday. Fire it with `curl -s -X POST localhost:$WORKER_PORT/dev/fire -d '{"user":"rut1","key":"<key>"}'`, then wait for a second `requested` push. The same key is still pending with the same repeat. On scripted, add `"repeat":"weekdays"` to the `schedule_wakeup` action.
- **Cancel.** Set a reminder 30 minutes out, then run `$GV say rem1 "Cancel that reminder"` (scripted: `{"type":"cancel_wakeup","key":"water"}`). Wait for `!s.pendingWakeups.some(w => w.kind === "reminder")`.
- **Late (test-only clock).** Set a reminder 30 minutes out and read its key from the snapshot. Run `$GV advance rem1 <key> 90`, then `$GV say rem1 ok`. The reminder's outbox text starts with a late notice line. Name the `advance` shortcut in the proof.

## Gotchas

- A person-asked reminder may be due as early as the current minute; only the agent's own wake-ups need a minute's lead. Two minutes is still the shortest ask that reliably lands in the future.
- A person may hold at most 20 pending reminders. Keys match `^[a-z0-9][a-z0-9-]{0,39}$`, and `daily-checkin` is reserved.
- Cancels apply before schedules in one turn. A cancel plus a rejected reschedule of the same key keeps the original reminder and tells the person.
- Reminders fire on wall-clock time. A `wait` shorter than the time to due fails by design.
- `advance` alone fires nothing. The wake-up fires on the next drain, which a `say` starts. That message gets its own turn first.
