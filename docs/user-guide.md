# User guide

## Install

Use Pi 1.2.0 and Node.js 22.19 or newer. Node 24 or 26 is recommended for SQLite. Install the fork with `pi install npm:@pi-switch/pi-codex-app-server` after its first npm release. The unscoped npm name installs upstream.

For a source checkout, install dependencies with Bun 1.4.3, run `bun run build`, then use `pi install /absolute/path/to/checkout`. The extension loads from TypeScript and its daemon uses that Pi installation's runtime modules. The tarball includes source, compiled entrypoints, migrations, protocol contracts, and documentation.

## Share a session with Codex CLI

1. Open the desired Pi session and run `/codex-server status`.
2. If stopped, run `/codex-server start`.
3. Copy the printed `codex --remote ... resume ...` command into another pane.
4. Send input from either interface. Both must show the same conversation and session ID.

After an extension update, run `/reload` while idle before reconnecting. An old Pi process with presence but no owner channel blocks remote writes rather than starting a second writer.

## Desktop and ChatGPT Remote

Use Pi's `/login` to configure the `openai-codex` OAuth provider. An API key is insufficient for Remote enrollment. Run `/codex-server pair`, then enter or scan the short-lived code in the client's connected-host flow. Once the host appears, open its Pi project or session.

`running` confirms the daemon process and endpoint, not desktop rendering. A chat can be readable through the server while a custom section retains outdated membership. Configure the [native adapter](sidebar-sync.md#live-desktop-adapter) for automatic placement of new unassigned chats.

The adapter needs the connected Pi host ID, desktop destination section ID, and a real local caller task ID. Desktop section IDs differ from backend section IDs. Native `list_threads` supplies desktop organization IDs. A desktop-launched task receives its caller and initial endpoint through `CODEX_THREAD_ID` and `CODEX_APP_TOOLS_PIPE_PATH`.

Repository entries also require desktop's saved project catalog. Use the [offline importer](sidebar-sync.md) for initial registration. Preview with desktop open; apply only after closing it. A verified backup is created. The live adapter performs native operations and does not edit the desktop state file.

## Control commands

| Command | Behavior |
| --- | --- |
| `/codex-server status` | PID, URL, flags, session ID, connection command, paths |
| `/codex-server start` | Start a stopped daemon and wait for readiness |
| `/codex-server stop` | Stop the daemon; attached clients disconnect |
| `/codex-server pair` | Request a Remote Control pairing code |

Standalone `pi-codex-app-server app-server` serves stdio, `daemon` serves WebSocket, and `pair` prints a code. Source checkout equivalents are `node dist/cli.js <command>`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_CODEX_APP_SERVER_AUTOSTART` | `1` | Set `0` to disable extension autostart |
| `PI_CODEX_APP_SERVER_HOME` | `<Pi agent dir>/codex-app-server` | Runtime state and logs |
| `PI_CODEX_APP_SERVER_HOST_NAME` | Machine hostname | Connected-host display name |
| `PI_CODEX_APP_SERVER_LISTEN` | `ws://127.0.0.1:0` | Listening URL; zero selects a free port |
| `PI_CODEX_REMOTE_CONTROL` | `1` | Set `0` to disable enrollment and relay access |
| `PI_CODEX_REMOTE_BASE_URL` | `https://chatgpt.com/backend-api/` | Remote API endpoint override |

Keep direct WebSocket listening on loopback. It is not an authenticated public network service. External TLS termination is required for `wss://`.

Session visibility uses global or project Pi `settings.json`; see [publication settings](session-export.md). The adapter uses `desktop-sync.json` in the server home. These settings are not environment variables.

## Files and recovery

| Path | Contents |
| --- | --- |
| Pi session directory | Authoritative JSONL history |
| `state.sqlite` | Projects, archive flags, leases, sections, Remote state |
| `endpoint.json` | Daemon PID, URL, and start time |
| `owners/`, presence records | Live Pi registrations; do not edit manually |
| `desktop-sync.json` | Optional adapter configuration |
| `logs/` | Daemon stdout and JSONL request diagnostics |

Back up history and metadata separately. Stop the daemon before copying SQLite and its sidecar files for a consistent backup. Do not remove history to repair sidebar placement. Diagnostics record methods, IDs, and failures without conversation content or tool arguments; inspect logs before sharing them.

For startup failure, inspect the logged error and configured port. A stale endpoint pointing at a dead PID is treated as stopped. If the owner disappears during a turn, inspect persisted history before retrying; uncertain commands are not replayed automatically.

For missing desktop chats, inspect adapter configuration and its `synchronized` confirmation in daemon stdout. Endpoint discovery refuses ambiguous apps and revalidates capabilities after reconnect. Desktop updates may require adapter changes independently of protocol updates.

## Update or remove

Update through Pi package management, rebuild local checkouts, then `/reload` idle Pi processes. An already running daemon contains previous compiled code; restart it only after active work completes.

To remove, run `/codex-server stop`, then `pi remove npm:@pi-switch/pi-codex-app-server`, or remove the matching local source. Preserve the server home if project and archive metadata are still needed. Removal does not require deleting history. Stop the live Pi owner before explicitly deleting a session through Codex.
