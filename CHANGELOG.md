# Changelog

## 0.2.0 (fork, unreleased)

- Publish the fork identity as `@pi-switch/pi-codex-app-server`, retaining the `pi-codex-app-server` command.
- Share native Pi TUI sessions with Codex through a single-writer owner bridge.
- Recover desktop history, runtime status, and relay sequence state across reconnects.
- Synchronize newly published chats through native desktop host tools.
- Add session publication controls and protocol generation with verified artifact digests.
- Remove the bundled skill collection and replace generic guidance with project contracts.
- Add user, architecture, development, packaging, and acceptance documentation.
- Verify pull requests and package installation before release.
- Target Pi 1.2.0 with matching SDK dependencies and a 1.2.x peer contract.
- Reuse unchanged session summaries, coalesce catalog scans, and batch metadata writes during client startup.

The releases below are retained upstream history from Lqm1/pi-codex-app-server.

## [0.1.1](https://github.com/Lqm1/pi-codex-app-server/compare/pi-codex-app-server-v0.1.0...pi-codex-app-server-v0.1.1) (2026-08-24)


### Bug Fixes

* install Pi runtime dependencies for daemon ([e210406](https://github.com/Lqm1/pi-codex-app-server/commit/e21040653a69bd9f8522439df8baf92a91eaca84))

## 0.1.0 (2026-08-24)

### Features

- implement Pi-backed Codex app server ([b57a170](https://github.com/Lqm1/pi-codex-app-server/commit/b57a1707cdae64146839a16708c8ed2e75ce5447))
- improve Codex server extension controls ([04d120f](https://github.com/Lqm1/pi-codex-app-server/commit/04d120fe01c170a2fb5a4db44df43b31dfe82f85))

### Bug Fixes

- show pairing QR code in an overlay ([b3d3033](https://github.com/Lqm1/pi-codex-app-server/commit/b3d3033751eb5b041637636d22c4e6449d2c4458))
- show provider names in model catalog ([ea5b261](https://github.com/Lqm1/pi-codex-app-server/commit/ea5b2613d1d4c0a51c03d35c5ae1b0baacd97c00))

### Miscellaneous Chores

- prepare initial release ([9c1c371](https://github.com/Lqm1/pi-codex-app-server/commit/9c1c371037fcce662980c4271b755824e3c821d4))
