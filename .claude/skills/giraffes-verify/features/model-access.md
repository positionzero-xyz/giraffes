# Model access (mvp/model-access and later)

What a person sees when they bring their own key, and what the agent does when it has none. Scripted backend plus the local stub provider; never a real provider.

## Preconditions

- A scripted run. `prepare` writes `KEY_SECRET` (32+ characters, which config requires) and `PUBLIC_URL` into `.dev.vars`.
- The stub on a free loopback port away from the bridge's: `node <skill>/scripts/stub-provider.mjs 18799 <fake key> $RUN_DIR/evidence/stub.log $RUN_DIR/evidence/compactions.jsonl`, started with run_in_background. The fake key must start `sk-` for the Alibaba preset. Afterwards, kill it with `taskkill //T //F //PID $(cat $RUN_DIR/evidence/stub.log.pid)` and confirm the port is free.
- With `DEV_MODE`, a preset may point at the loopback stub over http. Use the Alibaba preset (`qwen3.7-flash`, about 27,000 prompt bytes) for size checks, because it is the smallest budget and fails first.

## Paths

- **No access.** A fresh dev person with nothing connected and no `/dev/script` gets the code-written "connect your AI" offer once per local day. The ledger shows outcome `no_access` and no `model_call` row.
- **Key page.** `$GV say key1 /key` replies with `<PUBLIC_URL>/key#t=<ticket>&l=<lang>`; the ticket is in the fragment and expires in 15 minutes. `GET /key` serves the page. The page's submit is `POST /key` with `{"ticket","provider":"alibaba","model":"","baseUrl":"http://127.0.0.1:18799","key":"<fake key>"}`, so curl can drive it. Expect `200 {"ok":true,"provider":"Alibaba Model Studio","model":"qwen3.7-flash"}`. A repeat POST with the same ticket returns the same body, and `stub.log` gains no second `probe` line. Check three more things. The snapshot's `access.key` shows `provider`, `hint` (the last 4 characters), `mode: "loose"` and `sealedBytes`, never the key, and `access.lanes` is `["key"]`. `$GV dosql key1 "SELECT status, outcome FROM key_ticket"` reads `saved`. The ledger shows a `probe` row and then `turn` rows with `backend = key`.
- **Pasted key.** Send `key=sk-ant-<fake>` and a URL containing `sk-or-<fake>`. History and the inbox hold `<a key, removed>`, the person gets the warning with a fresh link, the turn ends `no_model`, and no model is called. Prove absence with `grep -ral <fake> $RUN_DIR/state` (0 files), and prove the grep works with a control string you know is there, such as a stub reply.
- **No usage, hang.** A newest message containing `NOUSAGE` makes the stub omit usage, and the ledger shows `usage_missing` charged at the estimate. `HANGNOW` makes it hang once. The call settles `in_doubt` after 60 seconds, the retry answers (the turn shows 2 attempts, about 90 seconds in all), and the next message is answered.
- **Long Thai.** Send a dozen Thai messages of about 4 KB each on the Alibaba route, one at a time, waiting for each answer by counting outbox rows (compaction removes turns from the snapshot, so a turn count goes down). Compaction runs before a turn when needed. Every request `stub.log` records stays within the route's byte budget. `history_trimmed` stays 0. Each message is either still in the snapshot's turns or appears whole in a compaction prompt dumped to `compactions.jsonl`. Thai is the hardest input here: 3 bytes per character, and it breaks any code (or stub) that decodes byte chunks one at a time.
