# Sync the Codex desktop sidebar

The daemon persists repository projects and thread sections in its SQLite metadata. It discovers repository roots from Pi session working directories, including nested directories and Git worktrees. Sessions outside Git stay in the Pi section unless explicitly assigned to a project. Missing working directories do not create projects.

Codex desktop also keeps a saved remote-project catalog in `.codex-global-state.json`. A server `project/list` response does not populate that catalog. This script registers those projects, assigns their sessions, and places the project entries and remaining sessions in a sidebar section.

## Run on the same machine

Run these recipes from the repository in an external terminal. `just` lists the available commands. `just install` installs dependencies from the lockfile. Each sidebar recipe builds the CLI first.

If the daemon is stopped, run this in a separate terminal and keep it open:

```powershell
just daemon
```

With Codex desktop still open, export a fresh snapshot and preview the import:

```powershell
just sidebar-preview
```

This writes `.cache/pi-sidebar.snapshot.json` and prints the plan without changing desktop state. The host is inferred from matching source section bindings and ownership of the imported sessions. Conflicting or missing bindings abort. No PowerShell variable is required.

Exit Codex desktop, including any tray instance. Run from a separate terminal:

```powershell
just sidebar-apply
```

Open Codex again. Apply reads the saved snapshot and does not connect to the daemon. The daemon can stop when Codex exits without breaking the import. The command prints a verified completion message and the backup path. It does not close or restart the app, launch background helpers, or modify Pi history. `just sidebar-plan` previews the saved snapshot without a daemon connection. Refresh with `just sidebar-preview` if sessions or project assignments changed before applying.

For another host or a custom snapshot location, add an ignored `.env` file at the repository root. `just` loads it:

```dotenv
PI_CODEX_HOST_ID=remote-control:ENVIRONMENT_ID
PI_SIDEBAR_SNAPSHOT=.cache/pi-sidebar.snapshot.json
```

Set `PI_CODEX_HOST_ID` only when inference is unavailable or you need an explicit selection. Use the connected host ID shown by Codex, including its `remote-control:` or `remote-ssh-...:` prefix. The endpoint must belong to that host. The script cannot verify an explicit desktop host ID against an arbitrary endpoint. `PI_CODEX_APP_SERVER_HOME`, `PI_CODING_AGENT_DIR`, and `CODEX_HOME` also work in `.env`.

The built CLI works with Node.js 22.18 or newer. `sync --dry-run` remains available for direct use, but the recipes use export followed by offline apply so closing desktop cannot remove their source endpoint.

## Pi runs on another machine

Export on the machine running the daemon:

```bash
node dist/sidebar-sync.js export --output pi-sidebar.snapshot.json
```

Copy that snapshot to `.cache/pi-sidebar.snapshot.json` on the desktop machine. Create the parent directory if needed. Preview, then apply with Codex desktop closed:

```powershell
just sidebar-plan
just sidebar-apply
```

Version 2 snapshots contain project roots, names, session IDs, project assignments, last activity timestamps, archive flags, and the source metadata directory. They do not contain conversation text or credentials. Version 1 snapshots lack activity timestamps and must be refreshed with `just sidebar-preview`. Direct export refuses to overwrite an existing snapshot unless `--overwrite` is specified. `just sidebar-preview` refreshes its snapshot through an atomic replacement after a successful export.

## Options and behavior

| Option | Default | Purpose |
| --- | --- | --- |
| `--host-id` | `PI_CODEX_HOST_ID`, otherwise inferred | Connected host owning the imported sessions |
| `--endpoint` | `<Pi app-server home>/endpoint.json` | Endpoint file or `ws://` / `wss://` URL; used by sync/export |
| `--codex-home` | `CODEX_HOME`, otherwise `~/.codex` | Desktop state directory |
| `--section` | `Pi` | Destination sidebar section name |
| `--account-id` | The sole sidebar account | Required when account selection is ambiguous |
| `--dry-run` | Off | Preview without writing desktop state |

The default endpoint respects `PI_CODEX_APP_SERVER_HOME` and `PI_CODING_AGENT_DIR`. `--help` lists each command's options.

The snapshot includes only sessions allowed by [Pi session publication settings](session-export.md). Apply withdraws saved session references owned by the selected host when they are absent from the full snapshot. Export a fresh snapshot after policy changes; the plan reports the withdrawal count. Pi history and session files are not changed. The `just` export recipes omit projects without published sessions, so recovery does not register unrelated empty repositories. Existing desktop project registrations are preserved. Direct CLI exports include all projects unless `--skip-empty-projects` is specified.

## Recover saved references after publication changes

Use the same export, preview, apply, and restore commands for any connected Pi host. They also repair stale custom-section order. Keep the intended Pi sessions open when publication is `active`; an empty catalog withdraws all saved session references belonging to the selected host. Check `hostId` and `withdrawnThreads` in the preview before applying.

For a daemon on the desktop machine:

```sh
just sidebar-preview
```

For WSL, first update and build this repository inside the target distribution. From the Windows checkout, supply that distribution's name and its Linux checkout path:

```powershell
just sidebar-preview-wsl Ubuntu /home/your-user/tools/pi-codex-app-server
```

This runs the Linux CLI through `wsl.exe --exec`, validates its JSON output, atomically saves the snapshot on Windows, and previews the import. It does not require localhost port forwarding. A failed export leaves the previous snapshot intact. `just sidebar-export-wsl <distribution> <repository>` exports without preview; `just sidebar-export` does the same for the local daemon.

Close Codex completely and use an external terminal to apply the saved candidate:

```sh
just sidebar-plan
just sidebar-apply
```

Apply does not contact the daemon or require WSL to remain connected. It refuses writes while Codex is running, checks for concurrent state changes, creates a backup, and verifies the replacement. It does not delete Pi history. Reopen Codex after success. Restore a backup with Codex closed using `just sidebar-restore <backup>`.

Set host selection and snapshot settings in an ignored `.env` file, especially when working with multiple hosts:

```dotenv
PI_CODEX_HOST_ID=remote-control:YOUR_HOST_ID
PI_SIDEBAR_SNAPSHOT=.cache/pi-sidebar.snapshot.json
PI_SIDEBAR_SECTION=Pi
```

Host inference is used when `PI_CODEX_HOST_ID` is absent; ambiguous ownership aborts. `PI_SIDEBAR_ENDPOINT` selects another local endpoint file or WebSocket URL. WSL export uses the Linux checkout's normal daemon endpoint configuration. For SSH hosts, run `just sidebar-export` on the source, copy the resulting snapshot to the desktop checkout's configured snapshot path, then run `just sidebar-plan` and `just sidebar-apply` there.

For scripted transport, `node dist/sidebar-sync.js export --stdout` emits only snapshot JSON. `--stdout` and `--output` are mutually exclusive. Snapshots contain metadata, not conversation text or credentials.

Existing projects are matched by host and normalized root. Windows roots ignore case and slash direction; Unix roots retain case. Existing project IDs and labels are preserved. In the destination section, projects appear before individual chats and retain their relative order. Imported chats are ordered by last activity, newest first. Equal timestamps retain their previous order. Chats outside the snapshot keep their slots among the individual chats. Repeating an import produces the same state. Importing additional repositories adds entries without deleting unrelated projects.

Custom sections retain an explicit desktop item order. Changing the global chat sorting preference does not repair that saved order. The import refreshes it from source activity timestamps; it does not continuously reorder an open desktop app.

Codex desktop 26.1007.2314 also caches server section membership separately from conversation state. Receiving `thread/started` adds a conversation but does not invalidate the custom-section thread query. A native desktop section move invalidates that query and updates the saved section items. Server publication acknowledgements therefore do not prove that a new native Pi session appears in the custom Pi section. The live adapter below uses the native desktop operation. It does not patch desktop files or rewrite its saved state.

## Live desktop adapter

Build with `bun run build`. From a desktop-launched task, verify the adapter once:

```powershell
node dist/desktop-sync.js --host-id <connected-Pi-host> --section-id <desktop-Pi-section> --once
```

The caller task defaults to `CODEX_THREAD_ID`, and the initial host-tools endpoint defaults to `CODEX_APP_TOOLS_PIPE_PATH`. An external terminal must supply its actual registered caller through `--caller-thread-id`. Use the desktop section ID from `list_threads`, not the backend's `threadSection/list` ID. The configured host must own the selected Pi daemon.

For automatic lifecycle management, create `desktop-sync.json` in the app-server home:

```json
{
  "enabled": true,
  "hostId": "connected-Pi-host",
  "sectionId": "desktop-Pi-section",
  "callerThreadId": "actual-local-caller-task"
}
```

On its next start, the daemon launches and supervises the adapter. No desktop restart is needed. Stop the adapter by setting `enabled` to false before the next daemon start. Pi continues to own agent execution; this process only reads publication metadata and performs sidebar operations.

One desktop-side adapter can reconcile several Pi hosts. Add a `sources` array to that same configuration:

```json
{
  "enabled": true,
  "hostId": "connected-Windows-Pi-host",
  "sectionId": "desktop-Pi-section",
  "callerThreadId": "actual-local-caller-task",
  "sources": [
    {
      "hostId": "connected-Windows-Pi-host",
      "endpoint": "C:/path/to/pi-agent/codex-app-server/endpoint.json"
    },
    {
      "hostId": "connected-WSL-Pi-host",
      "wsl": {
        "distribution": "Ubuntu",
        "repository": "/home/your-user/tools/pi-codex-app-server"
      }
    }
  ]
}
```

Each source needs its actual connected desktop host ID. `endpoint` accepts a daemon endpoint file or WebSocket URL reachable from the desktop machine. WSL sources run the built Linux CLI through `wsl.exe` and do not require localhost forwarding. Both checkouts must include the multi-source adapter update. Publication and backend Pi-section membership determine eligible chats; the adapter does not scan session files or import history independently.

If the daemon inherited an expired desktop pipe, the optional top-level `pipe` setting can supply the current `CODEX_APP_TOOLS_PIPE_PATH` from a desktop-launched task. It is reloaded with the sources and takes precedence over the inherited hint. Windows still verifies the pipe owner against the installed desktop main executable. Ambiguous discovery prevents writes; the adapter does not choose an arbitrary pipe.

The source list is reloaded on every pass. Adding or removing a source does not require restarting either Pi session. Without `sources`, the legacy `hostId` and daemon endpoint remain the sole source. Duplicate host IDs or malformed source settings abort before writes. An unavailable source is reported through `failedHosts` and does not prevent successful source snapshots from being reconciled. An uncertain native write stops the pass; the next pass reads desktop inventory before another mutation. Removed or unavailable sources do not trigger automatic withdrawal of saved desktop references. Use offline recovery for that operation.

The adapter reconciles every five seconds after the preceding pass completes. It selects active members of the server's Pi section, skips project-assigned sessions, preserves placements in other custom sections and Pinned, and inserts missing chats before the first chat owned by the same backend. Projects retain their relative order and precede chats. When desktop chat sorting is `updated_at`, it also orders the destination's recent chats across hosts by activity. The native inventory contains at most 50 recent chats; older entries retain their relative order. Manual sorting is preserved, and unavailable hosts suspend ordering. Each successful move or reorder requires subsequent desktop confirmation. A failed or timed-out write is not blindly replayed; the next pass reads inventory first.

On Windows, endpoint discovery verifies the named pipe's owning process against the installed OpenAI.Codex main executable. A valid supplied endpoint wins. After it disappears, discovery requires exactly one verified candidate; ambiguity prevents writes. The tool catalog is checked again after reconnection. Other platforms require an explicit endpoint. The native transport is a private, version-sensitive desktop interface, so desktop updates require compatibility verification. Backend availability and visible running/completed behavior remain separate checks.

The snapshot's project assignments are authoritative for its sessions. Assigned sessions appear under their repository projects. Unassigned sessions go directly into the selected section. Imported sessions are removed from Pinned. Archived sessions retain assignments but do not become direct sidebar entries. Ownership conflicts with another host, duplicate roots or section names, unknown project references, and ambiguous accounts abort before writing.

The desktop saved-project format used here has one root per project. Multi-root source projects are rejected rather than partially imported. This script targets the current `sidebar-custom-sections-v3` desktop state format. It is not a legacy format converter.

## Write protection and rollback

Apply requires the desktop app to be stopped. Process detection covers the official Windows package, macOS app bundle, and Linux `codex-desktop` / `Codex/codex` executable layouts. Keep portable or custom builds closed too. A failed process probe aborts the command. Dry-run and export do not require closing the app.

The writer locks the state file against another script instance, verifies that the file has not changed since planning, creates a unique backup, writes a temporary file in the same directory, checks the app and file again, and atomically replaces the state file. It then reads the result back to verify it. Keep Codex closed until the command finishes. The app does not participate in the script's lock.

To restore, close Codex and pass the exact backup path printed by the command:

```powershell
just sidebar-restore 'C:\path\.codex-global-state.json.sidebar-backup-TIMESTAMP-UUID'
```

Restore replaces the whole desktop state with the backup, including settings changed after that backup. It first backs up the current state. Snapshots and backups are created with mode `0600` where the operating system supports Unix permissions.

The import and process guard were tested on Windows with Codex desktop 26.1007.2314. Process-layout tests cover macOS and Linux; full desktop imports on those systems were not tested.

The adapter repairs project placement through native project moves when a new host chat was inserted above the projects. It saves the intended project order in its own app-server home as `desktop-sync-project-order.json` before moving anything. After a timeout or process restart, it reconciles that plan with fresh desktop inventory and resumes after confirmed placements. The plan is removed after verification. It does not edit the desktop state file.
