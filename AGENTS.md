# Project contracts

- Pi owns execution, credentials, and JSONL history. Preserve the exclusive app-server lease and delegate to the live TUI owner.
- Reconcile persisted state before retrying uncertain agent commands, desktop mutations, or publication.
- Validate external JSON; keep runtime schemas aligned with the vendored protocol snapshot.
- Desktop host tools and app-server WebSockets are separate interfaces. Keep desktop binaries and running desktop state untouched.
- Diagnostics exclude conversation content, credentials, and tool arguments. Thread deletion removes the real Pi session file.
- Tests use isolated session storage and synthetic providers.
- Development: read [development.md](docs/development.md) for protocol regeneration, schema migrations, and verification. Run `bun run fix` before committing.
- Releases: read [the release procedure](docs/development.md#prepare-a-release) before versioning, preparing, publishing, or resuming a release.
- Local records belong in the ignored, unpackaged `docs/reports/`; release artifacts and notes use `docs/reports/releases/<version>/`.
