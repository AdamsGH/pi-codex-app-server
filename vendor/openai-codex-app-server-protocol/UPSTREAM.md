# OpenAI Codex app-server protocol snapshot

[protocol-snapshot.json](protocol-snapshot.json) records the generating CLI version, upstream release commit, and artifact digests. Text digests normalize CRLF to LF for portable checkouts. The handshake and remote enrollment use that version. `common.rs` is the matching upstream source used to generate the method map.

Run `bun run protocol:sync` from the repository root to replace the snapshot from the installed Codex CLI. Set `CODEX_PROTOCOL_CLI` to select another executable. This invokes `codex app-server generate-ts --experimental` and `codex app-server generate-json-schema --experimental` and fetches the matching release source. The command removes files that upstream no longer generates and writes the manifest after generation succeeds.

The generated files retain their upstream notices and are distributed under the upstream Apache License 2.0. Do not edit them by hand. Adapt the Pi projections to the new contract and pass the checks documented in the repository README before deployment.
