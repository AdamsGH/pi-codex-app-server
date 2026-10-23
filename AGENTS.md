# Repository guidance

Repository skills require an explicit user request, a declared source, and an update procedure. Do not restore a bundled skill collection.

- Pi owns model execution, credentials, and JSONL history. Preserve the single-writer lease and delegate to the live TUI owner when present.
- Never replay an uncertain agent command or desktop mutation automatically. Reconcile persisted state before retrying.
- Validate external JSON at boundaries. Keep generated method types and runtime schemas aligned with the vendored snapshot.
- Desktop host tools and the app-server WebSocket are separate interfaces. Do not patch desktop binaries or edit its saved state while running.
- Keep conversation content, credentials, and tool arguments out of diagnostics. Explicit thread deletion removes a real Pi session file.
- Use explicit domain types, bounded asynchronous operations, and the existing Ultracite configuration. Explain non-obvious invariants in short comments.
- Add meaningful regression tests. Use isolated session storage and synthetic providers for automated acceptance.
- Run `bun run fix` before committing and `bun run verify` before release. See [development.md](docs/development.md).
- Do not edit generated contracts by hand. Use `bun run protocol:sync`, review the diff, and run the checks.
- Create a new reviewed migration after changing `src/storage/schema.ts`. Preserve migrations already shipped to users.
- Keep investigation and acceptance reports local under the ignored `docs/reports/` directory. Do not commit or package them.
- Preserve upstream history and license notices. Do not add AI author or co-author attribution to commits or releases.

## Versioning and publication

- Follow [Semantic Versioning](https://semver.org/) with `MAJOR.MINOR.PATCH`. Choose the highest required bump across all changes since this fork package's last published version, not upstream tags.
- At `1.0.0` and later, increment PATCH for backward-compatible fixes, MINOR for backward-compatible functionality or deprecations, and MAJOR for incompatible public contract changes. Reset lower components to zero when incrementing MINOR or MAJOR.
- Before `1.0.0`, use this repository convention: compatible fixes increment PATCH (`0.2.0` to `0.2.1`); new functionality or incompatible changes increment MINOR (`0.2.1` to `0.3.0`). Document incompatible changes and migration steps. Declare `1.0.0` deliberately when the public contract is stable. SemVer itself does not guarantee compatibility for `0.y.z`.
- Treat exported APIs, CLI commands and options, configuration and defaults, protocol behavior, persisted data compatibility, and required runtime versions as public contracts when assessing a bump.
- Keep `package.json`, the changelog, `v<version>` tag, and release manifest consistent. Released versions and their contents are immutable. Corrections require a new version; never move a published tag or replace a published package.
- Publish the exact archive from a successful release preparation run at its recorded commit. Attach that same archive and its manifest and checksums to the GitHub Release. Follow [the release procedure](docs/development.md#prepare-a-release), including explicit publication authorization and registry verification before retrying an uncertain publish.
