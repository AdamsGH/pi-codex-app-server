# Release acceptance for 0.2.0

Manual desktop checks on 2026-10-15 used live Pi sessions on Windows and WSL. The user confirmed streaming, completion without a persistent spinner, recovery after a tool error, matching replies in Pi and desktop, subsequent messages, multiple desktop windows, parallel Windows/WSL activity, and sidebar order updates. iOS remains optional and untested.

During these checks, desktop twice retained an executed request in its local follow-up queue and blocked the next message before `turn/start` reached Pi. Closing extra windows did not immediately clear it. The queue later recovered; subsequent checks with one and multiple windows passed. The original client-side cause is unresolved. A daemon restart clearing the symptom is not proof of a fix.

An isolated regression reproduced a separate recovery defect: rebuilding history from JSONL discarded client message IDs and replaced live turn and user item IDs. Turn receipts now preserve these associations through the existing Pi writer. Tests reopen real isolated JSONL without an owner snapshot and check message identities. This corrects that demonstrated defect; it does not establish the cause of the earlier desktop queue stalls.

Keep publication pending until the queue issue is resolved or its remaining uncertainty is explicitly accepted. Capture a client snapshot with the [queue probe](desktop-queue-diagnostics.md) if it recurs. Do not resend an uncertain command automatically.
