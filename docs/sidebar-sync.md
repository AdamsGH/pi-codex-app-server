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

Snapshots contain project roots, names, session IDs, project assignments, archive flags, and the source metadata directory. They do not contain conversation text or credentials. Direct export refuses to overwrite an existing snapshot unless `--overwrite` is specified. `just sidebar-preview` refreshes its snapshot through an atomic replacement after a successful export.

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

Existing projects are matched by host and normalized root. Windows roots ignore case and slash direction; Unix roots retain case. Existing project IDs and labels are preserved. In the destination section, projects appear before individual chats. Order within each group is preserved. Repeating an import produces the same state. Importing additional repositories adds entries without deleting unrelated projects.

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
