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

# Run formatting checks, type checks, and tests.
check:
    bun run check
    bun run typecheck
    bun run test

# Run the daemon in this terminal. Keep it open while exporting.
daemon: build
    node dist/cli.js daemon

# Save a fresh snapshot and preview the import. Codex can remain open.
sidebar-preview: build
    node dist/sidebar-sync.js export --output "{{snapshot}}" --overwrite
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
