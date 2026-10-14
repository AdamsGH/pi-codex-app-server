# Session publication settings

Configure the extension in Pi's global `~/.pi/agent/settings.json` or project `<session cwd>/.pi/settings.json`. The global directory respects `PI_CODING_AGENT_DIR`. The daemon reads project settings for each session's working directory, not its own launch directory. Project settings override only the specified fields. They do not automatically inherit from parent directories.

```json
{
  "codexAppServer": {
    "sessionExport": {
      "unassigned": { "mode": "all", "maxAgeDays": 30 },
      "projects": { "mode": "all", "maxAgeDays": null }
    }
  }
}
```

`unassigned` controls sessions without an assigned Pi project. `projects` controls sessions assigned to a project, including manual assignments. Both default to `mode: "active"` and `maxAgeDays: null`. Connecting a new host does not publish its historical sessions unless `mode: "all"` is explicitly configured. The example above opts into history publication.

| Setting | Behavior |
| --- | --- |
| `mode: "all"` | Publish sessions within the age limit, plus active sessions |
| `mode: "active"` | Publish only sessions currently open in Pi or in use by Codex |
| `mode: "off"` | Publish no sessions in this category, including active sessions; reject Codex thread creation in that category |
| `maxAgeDays: N` | Positive integer. Measure elapsed 24-hour days from the last activity recorded by Pi |
| `maxAgeDays: null` | No age limit |

For example, a project can publish only its active sessions:

```json
{
  "codexAppServer": {
    "sessionExport": {
      "projects": { "mode": "active" }
    }
  }
}
```

The age limit uses Pi's session activity timestamp, not the JSONL file's modification time. Active sessions bypass the age limit. `off` overrides activity. A project override of `maxAgeDays: null` removes an inherited limit.

## Active sessions

The Pi extension maintains a presence file for its current session. New, resumed, and forked sessions replace that process's previous presence. Multiple Pi processes can publish multiple active sessions. Normal shutdown removes presence immediately. Crashes are detected by checking the recorded PID; heartbeat records also expire after 30 seconds to limit PID reuse and stale registrations. Presence is refreshed every 10 seconds.

Codex keeps a session active after `thread/resume`, a history read with `includeTurns: true`, or `thread/start`. `thread/unsubscribe` releases that connection's subscription. Disconnect releases all its subscriptions. A running Codex turn keeps the session active until completion even if its client disconnects. Merely listing sessions or retaining a loaded SDK object does not mark a session active. The daemon's embedded Pi runtime does not register terminal presence.

After upgrading this extension, run `/reload` in already running Pi processes so they can register presence. New Pi processes register automatically.

## Refresh and desktop state

Automatic membership in the default Pi section follows source activity order, including after reconnect. Explicit section moves retain their stored positions.

Policy files are read on catalog requests and during the connected-client refresh, which runs every 5 seconds. Settings edits do not require a daemon restart. Invalid settings fail catalog requests and withdraw publication during refresh rather than falling back to unrestricted export. Errors identify the settings file in daemon logs.

The server emits `thread/deleted` when a session leaves its published catalog and `thread/started` when it reappears. These notifications withdraw or restore the Codex representation. They do not delete Pi history, session files, or metadata, and do not change Pi archive flags. Projects remain registered when all their sessions are hidden.

The sidebar exporter reads the filtered catalog. Import removes saved references for sessions owned by the selected host but absent from the full snapshot, including pinned entries and project assignments. Sessions belonging to other hosts are preserved. Always use a fresh snapshot after changing publication settings. `just sidebar-preview` reports `withdrawnThreads`; `just sidebar-apply` reconciles persisted desktop state while Codex is closed. Desktop can retain saved custom-section references after receiving withdrawal notifications. If those references remain, use the offline import; the live adapter does not remove them or delete Pi history.
