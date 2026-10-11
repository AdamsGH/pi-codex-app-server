# Sync the Codex desktop sidebar

The daemon persists repository projects and thread sections in its SQLite metadata. It discovers repository roots from Pi session working directories, including nested directories and Git worktrees. Sessions outside Git stay in the Pi section unless explicitly assigned to a project. Missing working directories do not create projects.

Codex desktop also keeps a saved remote-project catalog in `.codex-global-state.json`. A server `project/list` response does not populate that catalog. This script registers those projects, assigns their sessions, and places the project entries and remaining sessions in a sidebar section.

## Run on the same machine

Run from the repository with dependencies installed. Keep the Pi daemon running. Preview works while Codex desktop is open:

```powershell
bun run sidebar sync --host-id 'remote-control:ENVIRONMENT_ID' --dry-run
```

Use the connected host ID shown by Codex, including its `remote-control:` or `remote-ssh-...:` prefix. The endpoint must belong to that host. The script cannot verify a desktop host ID against an arbitrary endpoint.

Exit Codex desktop, including any tray instance. Run from a separate terminal:

```powershell
bun run sidebar sync --host-id 'remote-control:ENVIRONMENT_ID'
```

Open Codex again. The command prints a verified completion message and the backup path. It does not close or restart the app, launch background helpers, or modify Pi history.

After building, the same command works with Node.js 22.18 or newer:

```powershell
bun run build
node dist/sidebar-sync.js sync --host-id 'remote-control:ENVIRONMENT_ID' --dry-run
```

## Pi runs on another machine

Export on the machine running the daemon:

```bash
node dist/sidebar-sync.js export --output pi-sidebar.snapshot.json
```

Copy that snapshot to the desktop machine. Preview, then apply with Codex desktop closed:

```powershell
node dist/sidebar-sync.js apply --input pi-sidebar.snapshot.json --host-id 'remote-control:ENVIRONMENT_ID' --dry-run
node dist/sidebar-sync.js apply --input pi-sidebar.snapshot.json --host-id 'remote-control:ENVIRONMENT_ID'
```

Snapshots contain project roots, names, session IDs, project assignments, archive flags, and the source metadata directory. They do not contain conversation text or credentials. Export refuses to overwrite an existing snapshot. Choose a new filename when refreshing it.

## Options and behavior

| Option | Default | Purpose |
| --- | --- | --- |
| `--host-id` | Required for sync/apply | Connected host owning the imported sessions |
| `--endpoint` | `<Pi app-server home>/endpoint.json` | Endpoint file or `ws://` / `wss://` URL; used by sync/export |
| `--codex-home` | `CODEX_HOME`, otherwise `~/.codex` | Desktop state directory |
| `--section` | `Pi` | Destination sidebar section name |
| `--account-id` | The sole sidebar account | Required when account selection is ambiguous |
| `--dry-run` | Off | Preview without writing desktop state |

The default endpoint respects `PI_CODEX_APP_SERVER_HOME` and `PI_CODING_AGENT_DIR`. `--help` lists each command's options.

Existing projects are matched by host and normalized root. Windows roots ignore case and slash direction; Unix roots retain case. Existing project IDs, labels, and item order are preserved. Repeating an import produces the same state. Importing additional repositories adds entries without deleting unrelated projects.

The snapshot's project assignments are authoritative for its sessions. Assigned sessions appear under their repository projects. Unassigned sessions go directly into the selected section. Imported sessions are removed from Pinned. Archived sessions retain assignments but do not become direct sidebar entries. Ownership conflicts with another host, duplicate roots or section names, unknown project references, and ambiguous accounts abort before writing.

The desktop saved-project format used here has one root per project. Multi-root source projects are rejected rather than partially imported. This script targets the current `sidebar-custom-sections-v3` desktop state format. It is not a legacy format converter.

## Write protection and rollback

Apply requires the desktop app to be stopped. Process detection covers the official Windows package, macOS app bundle, and Linux `codex-desktop` / `Codex/codex` executable layouts. Keep portable or custom builds closed too. A failed process probe aborts the command. Dry-run and export do not require closing the app.

The writer locks the state file against another script instance, verifies that the file has not changed since planning, creates a unique backup, writes a temporary file in the same directory, checks the app and file again, and atomically replaces the state file. It then reads the result back to verify it. Keep Codex closed until the command finishes. The app does not participate in the script's lock.

To restore, close Codex and pass the exact backup path printed by the command:

```powershell
node dist/sidebar-sync.js restore --backup 'C:\path\.codex-global-state.json.sidebar-backup-TIMESTAMP-UUID'
```

Restore replaces the whole desktop state with the backup, including settings changed after that backup. It first backs up the current state. Snapshots and backups are created with mode `0600` where the operating system supports Unix permissions.

The import and process guard were tested on Windows with Codex desktop 26.1007.2314. Process-layout tests cover macOS and Linux; full desktop imports on those systems were not tested.
