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
- Preserve upstream history and license notices. Do not add AI author or co-author attribution to commits or releases.
