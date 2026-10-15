# Desktop queue diagnostics

This read-only DevTools probe inspects the desktop manager cache when queued messages do not reach `turn/start`. It reports turn IDs, client message IDs, ownership, resume state, and runtime status. It omits message text, tool arguments, credentials, and request bodies. It does not send messages, resume threads, clear queues, or modify saved desktop state.

Generate the console expression from the repository:

```sh
just desktop-queue-probe <host-id> <thread-id>
```

On Windows, append `| Set-Clipboard`. If DevTools are available in the affected desktop window, select Console, paste the generated expression, and run it. Inspect the resulting JSON before sharing it. The `threadId` must belong to the selected host.

The production desktop used in acceptance does not expose DevTools through Ctrl+Shift+I or its View menu. Its window configuration gates DevTools behind `allowDevtools`. The probe has passed synthetic serialization and redaction tests but has not been validated in a live desktop window. It cannot currently collect a snapshot from that production installation. Do not restart the application or patch its binaries to enable it during a stalled submission; doing so loses the state being investigated. Use existing desktop logs and read-only server metadata instead.

An explicitly authorized restart from an independent CLI tested both loopback `--remote-debugging-port` and `--inspect` arguments. Neither exposed a listener in Windows desktop 26.1007.9446.0. Its runtime is Chromium/Owl with an Electron-compatible application interface. Application logs confirmed the production build disables DevTools. No application binaries, runtime policy, or saved state were patched; the application was subsequently launched normally. These flags are not a working diagnostic path for this installation.

The implementation was derived from the installed Codex desktop 26.1007.9446.0 source, specifically `app-shared-30671c57ec82.js` and `app-initial-102e45562729.js`. It uses the `v$t` manager registry atom and its `forHost`, `getConversation`, and `getStreamRole` read interfaces. React fibers are used only to locate the existing store.

The probe refuses other bundle hashes. After a desktop update, inspect the installed source again, verify these read interfaces and the registry export, update the bundle guard, and run the serialization and redaction test. Do not remove the guard to force compatibility. This probe does not patch the desktop installation.

Completed turns now store `codex-app-server.turn-receipt.v1` custom entries through the Pi session's existing writer. These records contain only turn IDs and associations between persisted user entries, live item IDs, and client message IDs. They do not enter model context. Projection uses only validated associations present on the selected branch. A queued steer that Pi has not persisted is not acknowledged by the receipt. Older history without a receipt retains its previous projection; IDs cannot be reconstructed safely by guessing.

Debug logs record receipt persistence with thread and turn IDs and user counts. Receipt write failures produce a warning and do not suppress the actual execution outcome. No request is replayed as part of this recovery. Active processes must load the updated daemon and extension before they can write and restore these receipts.

## Isolated ownership reproduction

This command reads the installed archive, validates the reviewed module's SHA-256, extracts its ownership class and normalization helpers, and runs them in a separate VM context with synthetic state. It does not contact the running application, use real chats, or write the archive. TypeScript must be installed from the repository lockfile.

```powershell
$desktopArchive = Join-Path (Get-AppxPackage -Name OpenAI.Codex).InstallLocation 'app/resources/app.asar'
just desktop-ownership-check $desktopArchive
```

The fixture starts with two owners and queues each owner's snapshot before delivering either one. In desktop 26.1007.9446.0, both recipients accept the competing snapshot and become followers of each other. The result has `owners: 0`. A follower's queue execution path returns without starting work.

This reproduces an ownership failure under a constructed dual-owner state. It does not prove how that state arose in a running desktop or that the observed stalled queue has the same cause. The live logs show competing owner IDs, but DevTools were unavailable to inspect both current roles.

The script accepts only the reviewed `src-DCNiwad_.js` digest. After an application update, review the declarations and their dependencies again before changing the guard. No desktop source or extracted bundle is included in this repository.

## Live catalog updates

The installed desktop handles `thread/started` by updating its thread cache and broadcasting a complete ownership snapshot. Publication previously repeated that notification whenever a session's modification time changed, including during live turns.

For a thread already announced on a connection and loaded by Pi, activity-only catalog changes now avoid `thread/started`. Live turn events update the connected conversation; title changes use `thread/name/updated`. Fresh connections still receive the current full announcement. Unloaded history and structural changes retain full catalog updates. `thread/list` continues to return current timestamps and previews.

Regression tests cover idle and active live threads, unloaded history, fresh connections, title updates, and catalog timestamps. Removing redundant announcements reduces a demonstrated source of ownership snapshots. It does not repair an existing desktop ownership cycle or prove that the live queue stall is resolved.

## Replayed submissions

Live inspection subsequently found the same client message ID in two completed turns. Desktop retained an executed submission as pending and submitted it again with later input. A saved queue snapshot can differ from an open window's in-memory queue. An empty saved snapshot does not establish that all windows have cleared their queues.

Both the daemon and TUI owner now reconcile `clientUserMessageId` against the selected branch's validated receipts and live accepted input before starting or steering a run. A recognized ID returns its accepted turn without invoking Pi again or broadcasting another execution. Client message IDs identify immutable submissions within a thread. Reusing an accepted ID does not submit new input. Requests without an ID retain their existing behavior.

Receipts cannot reconstruct IDs missing from older history. Queued steering input that Pi has not persisted is recognized only while its live acceptance remains available. This is duplicate suppression for known accepted submissions, not a guarantee of exactly-once execution after every crash or persistence failure. Never infer acceptance by comparing message text or automatically replay an uncertain command.

## Native endpoint discovery

Windows discovery inventories installed desktop main processes once per invocation and checks named-pipe owner IDs against that inventory. The previous per-pipe CIM process query exceeded the discovery deadline when this installation exposed dozens of pipes. One live inventory contained 85 Desktop-owned endpoints, most of which were browser transports that rejected `tools/list`.

Discovery now performs a bounded read-only capability preflight and retains only endpoints exposing `codex_app/list_threads`. A valid explicit preference wins; a dead or browser-only preference can be replaced by a unique verified app-tools endpoint. Multiple genuine app-tools endpoints still require an explicit preference. The live installation resolved its unique native endpoint after a normal Desktop restart without selecting a browser transport or editing Desktop state.
