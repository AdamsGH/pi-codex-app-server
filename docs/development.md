# Development and releases

## Reproducible setup

Use Node 24 or 26 and Bun 1.4.3. The minimum runtime is Node 22.19, matching Pi's requirement. The Pi SDK packages and their internal dependencies are pinned to 1.2.0 in development. Overrides prevent a newer transitive package from breaking an older SDK's imports or introducing incompatible stream classes. Peer declarations permit the same 1.2.x family, not every Pi release.

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
| `bun run package:check` | Tarball contents, clean npm install, CLI, SQLite migrations, and extension loading with session-owner startup and cleanup |
| `bun run verify` | All release checks in order |

PR CI runs on Windows and Linux with Node 24 and 26. It does not claim visual desktop or live Remote Control acceptance. Package verification uses temporary storage and no model calls. Tests must not use the user's real auth or session directories.

## Database migrations

After changing `src/storage/schema.ts`, run `bun run db:generate` and review the new SQL and schema snapshot. Preserve shipped migrations. Random generated migration labels identify a versioned migration, not an installed database.

Exercise fresh database initialization and an upgrade from the previous schema. Back up a real database before applying a migration that changes or removes persisted data. Migrations are shipped in the npm package and run when `MetadataDatabase` opens.

## Protocol update

Regenerate contracts rather than editing generated files. Keep runtime validation aligned with the vendored snapshot. Use an explicitly selected Codex CLI version:

```sh
CODEX_PROTOCOL_CLI=/path/to/codex bun run protocol:sync
bun run fix
bun run verify
```

In PowerShell, set `$env:CODEX_PROTOCOL_CLI` before running the command. Generation invokes the CLI's experimental TypeScript and JSON Schema generators, retrieves the matching upstream release source, and regenerates the method map. Generated files are staged and validated before replacing the snapshot; backups permit rollback if publication fails. Review removed methods, changed fields, and generated notices. Protocol hash consistency is not a compatibility acceptance test.

Stop builds and other protocol-update processes before replacing generated contracts. If generation reports an interrupted publication, inspect its retained transaction directory before another update. Native desktop tools require a separate compatibility check after desktop updates.

## Live acceptance

Core regression tests cover history projection, owner leases, relay sequence recovery, and protocol validation. Native host-tools tests exercise fragmented frames, deadlines, cancellation, failed results, and endpoint selection.

See [desktop queue diagnostics](desktop-queue-diagnostics.md) for a read-only snapshot of client-side ownership and pending turn identities. Keep local acceptance reports under the ignored `docs/reports/` directory.

For sidebar acceptance, build and enable the adapter, then run from a desktop task:

```sh
bun run acceptance:sidebar --host-id <Pi-host> --section-id <desktop-Pi-section>
```

The script checks daemon and desktop availability before creating a synthetic Pi session without executing an agent. It checks automatic placement and repeated passes, then archives and removes that fixture. Failure after creation retains its file and evidence in the server home's `acceptance/` directory for explicit cleanup. It prints metadata only. A real running-turn check must still use the original active session in Pi and Codex; a fork or a saved-state check is insufficient. Confirm visible streaming, a failed tool followed by continued output, completion, and reconnect without persistent spinners.

## Prepare a release

Choose the highest required version bump across all changes since this fork package's last published version, not upstream tags. Before `1.0.0`, compatible fixes increment PATCH; functionality or incompatible changes increment MINOR. At `1.0.0` and later, use SemVer PATCH for compatible fixes, MINOR for compatible functionality or deprecations, and MAJOR for incompatible changes. Reset lower components on a MINOR or MAJOR bump. Assess exported APIs, CLI, configuration and defaults, protocol behavior, persisted data, and runtime requirements. Document incompatible changes and migration steps; declare `1.0.0` deliberately when the public contract is stable.

Released versions, tags, and package contents are immutable. Corrections require a new version. Publication requires explicit authorization and uses the exact successful CI archive, never a local repack.

1. Update `package.json` and the changelog. Run `bun run verify`, review the diff, commit, and push to `main`.
2. Run the manual **Prepare release** workflow on that commit. Wait for success, including exact-archive installation on Windows and Linux with Node 24 and 26. CI has no publishing credentials.
3. Review `docs/reports/releases/<version>/RELEASE.md`. State the observed failure, changed behavior, actual verification, and limitations. Record relevant Desktop acceptance without claiming untested behavior; iOS hardware testing is optional under [ADR 0004](adr/0004-require-chatgpt-mobile-remote.md).
4. With publication authorized and personal `gh` and npm authentication active, run `just release-publish <run-id>` in the clean checkout of the CI commit. Complete npm's browser confirmation when prompted. The command is done only when registry integrity, clean installation, GitHub author and body, tag, latest status, and all asset digests are verified.

The publisher downloads the `release-candidate` into `docs/reports/releases/<version>/ci/`, verifies it against the checkout, creates or reconciles the GitHub draft, and submits its archive to npm. It then waits for registry visibility, verifies publisher `adamsgh`, latest status and archive bytes, installs that registry archive in isolated storage, and publishes the GitHub Release with author `AdamsGH`. Release notes, the registry download, npm attempt receipt, and final `publication.json` stay under the same ignored version directory. Git and npm exclude all of `docs/reports/`.

### Resume an interrupted publication

Rerun the same `just release-publish <run-id>` with the same local release records. Existing tags, releases, and assets must match the candidate; published content is preserved. Run one publisher at a time across machines. A local lock prevents concurrent publishers in the same checkout.

The publisher writes `npm-attempt.json` before invoking npm. Once that receipt exists, a rerun only reconciles registry state; it does not resubmit the package. npm can return `202 Accepted` and exit successfully before metadata or tarballs become available. Checks tolerate transient registry failures and wait up to 30 minutes. A timeout leaves the GitHub draft and receipt intact. Keep the receipt while the result is uncertain: a registry `404` alone does not prove the upload failed. Resolve a definitively rejected upload with npm before retiring its receipt and authorizing another attempt.

### Local packaging diagnostics

For local preparation, run `just release-prepare` from a clean checkout. Output is `out/release/`. Repeating preparation verifies an existing matching candidate instead of replacing it. A candidate from another commit or with a changed checksum fails. CI artifacts are the release source; local output is for diagnostics.

```sh
bun run package:check --candidate /absolute/path/to/candidate/release.json
```

Publishing a tarball bypasses `prepublishOnly`; the publisher explicitly runs package checks before submission and after downloading from npm. npm organization access and GitHub access are independent.
