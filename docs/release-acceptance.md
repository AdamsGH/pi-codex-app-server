# Release acceptance for 0.2.0

Manual desktop checks on 2026-10-15 used live Pi sessions on Windows and WSL. The user confirmed streaming, completion without a persistent spinner, recovery after a tool error, matching replies in Pi and desktop, subsequent messages, multiple desktop windows, parallel Windows/WSL activity, and sidebar order updates. iOS remains optional and untested.

During these checks, desktop twice retained an executed request in its local follow-up queue and blocked the next message before `turn/start` reached Pi. Closing extra windows did not immediately clear it. The queue later recovered; subsequent checks with one and multiple windows passed. The original client-side cause is unresolved. A daemon restart clearing the symptom is not proof of a fix.

An isolated regression reproduced a separate recovery defect: rebuilding history from JSONL discarded client message IDs and replaced live turn and user item IDs. Turn receipts now preserve these associations through the existing Pi writer. Tests reopen real isolated JSONL without an owner snapshot and check message identities. This corrects that demonstrated defect; it does not establish the cause of the earlier desktop queue stalls.

After the receipt update was loaded, a second message stalled again while the preceding completed request remained `sending` in the desktop queue. The server was idle and retained the matching client message ID in its persisted receipt. Identity preservation therefore does not resolve the desktop queue stall. Desktop logs showed a successful `turn/start` response followed by repeated owner changes between two clients. The connection between these ownership transitions and the stalled submission still needs verification.

Keep publication pending until the queue issue is resolved or its remaining uncertainty is explicitly accepted. The [queue probe](desktop-queue-diagnostics.md) is unavailable in the production desktop because DevTools are disabled; use existing logs and read-only server metadata. Do not resend an uncertain command automatically.
