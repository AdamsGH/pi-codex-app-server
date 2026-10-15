# Desktop queue diagnostics

This read-only DevTools probe inspects the desktop manager cache when queued messages do not reach `turn/start`. It reports turn IDs, client message IDs, ownership, resume state, and runtime status. It omits message text, tool arguments, credentials, and request bodies. It does not send messages, resume threads, clear queues, or modify saved desktop state.

Generate the console expression from the repository:

```sh
just desktop-queue-probe <host-id> <thread-id>
```

On Windows, append `| Set-Clipboard`. Open DevTools in the affected desktop window with Ctrl+Shift+I, select Console, paste the generated expression, and run it. Inspect the resulting JSON before sharing it. The `threadId` must belong to the selected host.

The implementation was derived from the installed Codex desktop 26.1007.9446.0 source, specifically `app-shared-30671c57ec82.js` and `app-initial-102e45562729.js`. It uses the `v$t` manager registry atom and its `forHost`, `getConversation`, and `getStreamRole` read interfaces. React fibers are used only to locate the existing store.

The probe refuses other bundle hashes. After a desktop update, inspect the installed source again, verify these read interfaces and the registry export, update the bundle guard, and run the serialization and redaction test. Do not remove the guard to force compatibility. This probe does not patch the desktop installation.

Completed turns now store `codex-app-server.turn-receipt.v1` custom entries through the Pi session's existing writer. These records contain only turn IDs and associations between persisted user entries, live item IDs, and client message IDs. They do not enter model context. Projection uses only validated associations present on the selected branch. A queued steer that Pi has not persisted is not acknowledged by the receipt. Older history without a receipt retains its previous projection; IDs cannot be reconstructed safely by guessing.

Debug logs record receipt persistence with thread and turn IDs and user counts. Receipt write failures produce a warning and do not suppress the actual execution outcome. No request is replayed as part of this recovery. Active processes must load the updated daemon and extension before they can write and restore these receipts.
