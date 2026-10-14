# Architecture decision index

The existing numbered decisions are retained as project history. [Architecture](../architecture.md) describes the current fork; [the compatibility table](../../README.md#compatibility) records verified platforms and versions.

The single-writer contract in [0009](0009-use-a-single-writer-for-shared-sessions.md), Pi-owned execution in [0012](0012-keep-agent-execution-owned-by-pi.md), history projection in [0013](0013-project-pi-history-into-app-server-threads.md), and generated contracts in [0020](0020-use-generated-codex-contracts-with-json-rpc-2-0.md) remain core invariants.

[0006](0006-fix-the-backend-identity-after-project-testing.md) is resolved: compatibility identity comes from the pinned protocol manifest. [0007](0007-update-compatibility-reactively.md) remains a manual, reviewed update policy, not a continuous upstream mirror. [0008](0008-support-windows-and-macos-hosts-first.md) is a historical target-platform plan; its macOS priority does not mean that this fork has verified macOS desktop support.

The native desktop adapter adds a second host-tools channel. Server membership and desktop cache membership are distinct. Do not infer successful visual synchronization from server RPC responses or relay acknowledgements.
