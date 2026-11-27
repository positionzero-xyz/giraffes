# Conversation

A person texts the agent and gets a reply on the same chat. Messages that arrive while a turn is running are answered together.

## Sub-features

- `conv-reply` answers one message with an outbox row of intent `reply`.
- `conv-batch` folds consecutive messages into one turn.
- `conv-noaccess` answers a person with no AI connected with the code-written offer (`mvp/model-access` and later).
- `conv-failed` replies with the fixed apology when the model call keeps failing.
- `conv-page` shows the same exchange in the dev chat page.

## How to get to it (user POV)

- Send any text that is not `/follow` or `/block` on the dev channel.
- Type in the dev chat page at `/dev` and press `Send`.

## Driving it with gv

Preconditions:

- Bridge backend, or scripted with `/dev/script` (`mvp/fix-core` and later), for `conv-reply`, `conv-batch` and `conv-page`. Scripted for `conv-noaccess` and `conv-failed`.
- A fresh user per path.

- **Reply.** On bridge, run `$GV say conv1 "What can you do?"`. On scripted, first `POST /dev/script` with `{"user":"conv1","turns":[{"actions":[{"type":"send","text":"hi there"}],"tasks":[],"about":""}],"compaction":[]}`. Then `$GV wait conv1 's.outbox.some(o => o.intent === "reply" && o.status === "sent")' 90`. The snapshot has a `person` turn, an `agent` turn and a sent outbox row with `via: "reply"`. The ledger row has outcome `acted`.
- **Batch.** Run `$GV say conv1 "I'm planning a trip"` and `$GV say conv1 "to Chiang Mai in December"` back to back (scripted needs two entries), then wait until both have answers. `$GV ledger "SELECT batch_size FROM turn_log WHERE agent_key='p:dev:conv1'"` shows `batch_size` 2 when the second message arrived before the first turn claimed its batch. A 1 there is timing, not failure.
- **No access (scripted, `mvp/model-access`).** Without posting a script, run `$GV say conv2 hello`, then `$GV wait conv2 's.outbox.some(o => o.status === "sent")' 20`. The note turn and the sent reply are the "I need an AI to answer you, and you bring your own" offer. The ledger row has outcome `no_access`, and `model_call` has no row for `p:dev:conv2`. A second message the same local day gets outcome `no_access` and no reply.
- **Failed model.** Before `mvp/model-access`, any unscripted message takes this path. On later branches, post a script, use up its entries, and send one more message. The note turn and the sent text read `Sorry, I couldn't process that. Could you say it again?`. The ledger row has outcome `poison` with 3 attempts, `model_call` has three `in_doubt` rows charged at the estimate, and `worker.log` shows `drain failed` three times.
- **Chat page.** Open `http://127.0.0.1:<worker port>/dev` in the Browser pane. Set `input[name=user]` to `conv1`, type into `input[name=text]`, press `Send`. Within a few seconds `#turns` shows the message under `You` and the reply under `Agent`, and `#outbox` shows the text tagged `reply · sent · reply`. Screenshot the page and save `$GV snapshot conv1 conv-page` as the second view.

## Gotchas

- On a scripted run before `mvp/model-access`, every message from an unscripted person ends in the apology. That is the poison path working, not a bug.
- The reply arrives with `via: "push"` instead of `reply` when the turn ends more than 60 seconds after the message.
