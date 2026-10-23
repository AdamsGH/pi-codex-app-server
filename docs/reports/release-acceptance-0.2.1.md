# Release acceptance for 0.2.1

## Failure and correction

Opening an already active native Pi session with `pi -c` exited the second Pi window. The extension requested shutdown after failing to acquire the app-server session lease. The second window now remains usable without app-server attachment and shows `codex: disconnected (session in use)`. Other bridge startup failures show `codex: disconnected (bridge unavailable)`.

The attached window shows `codex: connected` instead of a daemon label and WebSocket URL. Details remain in `/codex-server status`. Daemon commands cannot overwrite the disconnected footer of a window without the session lease.

## Verification

On 2026-10-23, the user confirmed that native `pi -c` stayed open with the same session already open in another window. Reloading the original window while the second remained open also succeeded. After the footer update, the user reloaded and opened another pane with `pi -c`: the original window showed `connected`, and the second showed `disconnected`.

Local `bun run verify` passed on Windows with Node 26.10.0 and Bun 1.4.3: formatting and lint, TypeScript, 195 tests in 40 files, build, tarball contents, clean npm installation, CLI loading, extension loading, and migrations. The isolated attachment regression holds a real session lease, checks that native input continues without shutdown, verifies that the lease remains exclusive, and confirms that `/codex-server status` does not replace the disconnected footer when the daemon is running.

## Limits

No launcher or Pi runtime changes are required. The app-server lease remains exclusive, but disconnected native Pi windows are outside its write coordination. These checks do not establish safe concurrent native JSONL writes. The declared Pi 1.2.x peer contract is unchanged.

Cross-platform release preparation and installation of its exact candidate archive have not yet run for 0.2.1. Desktop and Remote Control acceptance were not repeated for this extension-only fix; the remaining Desktop ownership uncertainty recorded in [0.2.0 acceptance](release-acceptance-0.2.0.md) is unchanged.
