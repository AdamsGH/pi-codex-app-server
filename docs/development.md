# Development and releases

## Reproducible setup

Use Node 24 or 26 and Bun 1.4.3. The minimum runtime is Node 22.19, matching Pi's requirement. The Pi SDK packages and their internal dependencies are pinned to 1.1.0 in development. Overrides prevent a newer transitive package from breaking an older SDK's imports or introducing incompatible stream classes. Peer declarations permit the same 1.1.x family, not every Pi release.

```sh
bun install --frozen-lockfile
bun run verify
```

If the system Bun cannot parse the lockfile:

```sh
npm exec --yes --package=bun@1.4.3 -- bun install --frozen-lockfile
```

Use `bun.lock` as the sole project dependency lock. Do not commit a second npm lockfile. Do not accept an installer silently discarding the committed lock. When changing dependencies, review the resulting lock diff. Install hooks remain subject to Bun's trust policy; the project does not require enabling all dependency scripts.

## Checks

| Command | Checks |
| --- | --- |
| `bun run fix` | Format and lint fixes |
| `bun run check` | Formatting and lint |
| `bun run typecheck` | TypeScript contracts |
| `bun run test` | Isolated regression tests |
| `bun run build` | Snapshot consistency and compiled artifacts |
| `bun run package:check` | Tarball contents, clean npm install, CLI and SQLite migration smoke checks |
| `bun run verify` | All release checks in order |

PR CI runs on Windows and Linux with Node 24 and 26. It does not claim visual desktop or live Remote Control acceptance. Package verification uses temporary storage and no model calls. Tests must not use the user's real auth or session directories.

## Database migrations

Change `src/storage/schema.ts`, then run `bun run db:generate`. Review both the SQL and generated schema snapshot. Keep prior migration directories intact. Random generated migration labels are harmless; they identify a versioned migration, not an installed database.

Exercise fresh database initialization and an upgrade from the previous schema. Back up a real database before applying a migration that changes or removes persisted data. Migrations are shipped in the npm package and run when `MetadataDatabase` opens.

## Protocol update

Use an explicitly selected Codex CLI version:

```sh
CODEX_PROTOCOL_CLI=/path/to/codex bun run protocol:sync
bun run fix
bun run verify
```

In PowerShell, set `$env:CODEX_PROTOCOL_CLI` before running the command. Generation invokes the CLI's experimental TypeScript and JSON Schema generators, retrieves the matching upstream release source, and regenerates the method map. Generated files are staged and validated before replacing the snapshot; backups permit rollback if publication fails. Review removed methods, changed fields, and generated notices. Protocol hash consistency is not a compatibility acceptance test.

Stop builds and other protocol-update processes before replacing generated contracts. If generation reports an interrupted publication, inspect its retained transaction directory before another update. Native desktop tools require a separate compatibility check after desktop updates.

## Live acceptance

Core regression tests cover history projection, owner leases, relay sequence recovery, and protocol validation. Native host-tools tests exercise fragmented frames, deadlines, cancellation, failed results, and endpoint selection.

For sidebar acceptance, build and enable the adapter, then run from a desktop task:

```sh
bun run acceptance:sidebar --host-id <Pi-host> --section-id <desktop-Pi-section>
```

The script checks daemon and desktop availability before creating a synthetic Pi session without executing an agent. It checks automatic placement and repeated passes, then archives and removes that fixture. Failure after creation retains its file and evidence in the server home's `acceptance/` directory for explicit cleanup. It prints metadata only. A real running-turn check must still use the original active session in Pi and Codex; a fork or a saved-state check is insufficient. Confirm visible streaming, a failed tool followed by continued output, completion, and reconnect without persistent spinners.

## Prepare a release

The fork package is `@pi-switch/pi-codex-app-server`; its CLI name remains `pi-codex-app-server`. Update version and changelog, verify the GitHub source URL, run `bun run verify`, and inspect the resulting package inventory. Generated contracts, migrations, documentation, and notices must be present. Runtime databases, auth files, fixtures, and local caches must be absent.

No push or PR triggers npm publishing. After npm authorization is configured and publication is explicitly approved, publish the reviewed package with public scope access. `prepublishOnly` runs the verification sequence again. Verify the registry owner, version, contents, and source commit after publishing. npm organization access and GitHub access are independent.

The first scoped fork release is prepared as 0.2.0. Earlier changelog entries are upstream history. Preserve attribution and license notices when maintaining the fork.
