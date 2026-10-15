set windows-shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-Command"]
set dotenv-load

snapshot := env_var_or_default("PI_SIDEBAR_SNAPSHOT", ".cache/pi-sidebar.snapshot.json")

# List available commands.
default:
    @just --list

# Install dependencies from the lockfile.
install:
    bun install --frozen-lockfile

build:
    bun run build

# Prepare and verify a candidate without publishing it.
release-prepare:
    bun run verify
    bun run release:prepare

# Run formatting checks, type checks, and tests.
check:
    bun run check
    bun run typecheck
    bun run test

# Run the daemon in this terminal. Keep it open while exporting.
daemon: build
    node dist/cli.js daemon

# Print a read-only DevTools probe for the installed desktop queue.
desktop-queue-probe host thread:
    node scripts/desktop-queue-probe.mjs "{{host}}" "{{thread}}"

# Exercise installed desktop ownership code with synthetic state.
desktop-ownership-check asar:
    node scripts/check-desktop-ownership.mjs --asar "{{asar}}"

# Export publication metadata without changing desktop state.
sidebar-export: build
    node dist/sidebar-sync.js export --output "{{snapshot}}" --skip-empty-projects --overwrite

# Save a fresh snapshot and preview the import. Codex can remain open.
sidebar-preview: sidebar-export
    node dist/sidebar-sync.js apply --input "{{snapshot}}" --dry-run

# Export from a built WSL checkout to the desktop machine. Run on Windows.
sidebar-export-wsl distribution repository: build
    node dist/sidebar-sync.js export-wsl --distribution "{{distribution}}" --repository "{{repository}}" --output "{{snapshot}}" --skip-empty-projects --overwrite

# Export and preview WSL publication without editing desktop state.
sidebar-preview-wsl distribution repository: (sidebar-export-wsl distribution repository)
    node dist/sidebar-sync.js apply --input "{{snapshot}}" --dry-run

# Preview the saved snapshot without connecting to the daemon.
sidebar-plan: build
    node dist/sidebar-sync.js apply --input "{{snapshot}}" --dry-run

# Apply the saved snapshot with Codex closed. No daemon connection needed.
sidebar-apply: build
    node dist/sidebar-sync.js apply --input "{{snapshot}}"

# Restore a backup with Codex closed.
sidebar-restore backup: build
    node dist/sidebar-sync.js restore --backup "{{backup}}"
