import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { Command } from "commander";
import { z } from "zod";

import { assertDesktopStopped } from "./sidebar/desktop-processes.js";
import {
  parseSidebarFile,
  replaceSidebarFile,
} from "./sidebar/sidebar-files.js";
import { readSidebarSnapshot } from "./sidebar/sidebar-source.js";
import {
  planSidebarImport,
  sidebarSnapshotSchema,
} from "./sidebar/sidebar-state.js";
import type { SidebarSnapshot } from "./sidebar/sidebar-state.js";

const defaultHome = process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
const defaultEndpoint = path.join(
  process.env.PI_CODEX_APP_SERVER_HOME ??
    path.join(
      process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi", "agent"),
      "codex-app-server"
    ),
  "endpoint.json"
);
const importOptionsSchema = z.object({
  accountId: z.string().optional(),
  codexHome: z.string(),
  dryRun: z.boolean().default(false),
  hostId: z.string().min(1),
  section: z.string().min(1),
});

type ImportOptions = z.infer<typeof importOptionsSchema>;

const applySnapshot = async (
  snapshot: SidebarSnapshot,
  options: ImportOptions
): Promise<void> => {
  if (!options.dryRun) {
    await assertDesktopStopped();
  }
  const statePath = path.join(
    path.resolve(options.codexHome),
    ".codex-global-state.json"
  );
  const original = await readFile(statePath, "utf-8");
  const plan = planSidebarImport(
    parseSidebarFile(original),
    sidebarSnapshotSchema.parse(snapshot),
    {
      accountId: options.accountId,
      hostId: options.hostId,
      sectionName: options.section,
    }
  );
  process.stdout.write(
    `${JSON.stringify({ accountId: plan.accountId, assignedThreads: plan.assignedThreads, createdProjects: plan.createdProjects, dryRun: options.dryRun, hostId: options.hostId, projectCount: plan.projectCount, section: options.section, statePath }, null, 2)}\n`
  );
  if (options.dryRun) {
    return;
  }
  const backup = await replaceSidebarFile(statePath, original, plan.state);
  process.stdout.write(`Applied and verified. Backup: ${backup}\n`);
};

export const runSidebarSync = async (
  argv: readonly string[] = process.argv
): Promise<void> => {
  const program = new Command()
    .name("sync-codex-sidebar")
    .description(
      "Register app-server repository projects and group their sessions in Codex desktop"
    );
  program
    .command("export")
    .option(
      "--endpoint <path-or-url>",
      "App-server endpoint file or WebSocket URL",
      defaultEndpoint
    )
    .requiredOption("--output <file>", "Snapshot to create")
    .action(async (options: { endpoint: string; output: string }) => {
      const snapshot = await readSidebarSnapshot(options.endpoint);
      await writeFile(
        options.output,
        `${JSON.stringify(snapshot, null, 2)}\n`,
        { flag: "wx", mode: 0o600 }
      );
      process.stdout.write(
        `Exported ${snapshot.projects.length} projects and ${snapshot.threads.length} sessions to ${options.output}\n`
      );
    });
  const addImportOptions = (command: Command): Command =>
    command
      .requiredOption("--host-id <id>", "Connected host ID in Codex desktop")
      .option(
        "--codex-home <directory>",
        "Desktop state directory",
        defaultHome
      )
      .option("--section <name>", "Destination sidebar section", "Pi")
      .option(
        "--account-id <id>",
        "Sidebar account to change; inferred only when unambiguous"
      )
      .option(
        "--dry-run",
        "Show the plan without writing desktop state",
        false
      );
  addImportOptions(
    program
      .command("apply")
      .requiredOption("--input <file>", "Snapshot from export")
  ).action(async (options: { input: string }) => {
    await applySnapshot(
      sidebarSnapshotSchema.parse(
        JSON.parse(await readFile(options.input, "utf-8"))
      ),
      importOptionsSchema.parse(options)
    );
  });
  addImportOptions(
    program
      .command("sync")
      .option(
        "--endpoint <path-or-url>",
        "App-server endpoint file or WebSocket URL",
        defaultEndpoint
      )
  ).action(async (options: { endpoint: string; dryRun: boolean }) => {
    if (!options.dryRun) {
      await assertDesktopStopped();
    }
    await applySnapshot(
      await readSidebarSnapshot(options.endpoint),
      importOptionsSchema.parse(options)
    );
  });
  program
    .command("restore")
    .requiredOption("--backup <file>", "Backup produced by apply or sync")
    .option("--codex-home <directory>", "Desktop state directory", defaultHome)
    .action(async (options: { backup: string; codexHome: string }) => {
      await assertDesktopStopped();
      const statePath = path.join(
        path.resolve(options.codexHome),
        ".codex-global-state.json"
      );
      const original = await readFile(statePath, "utf-8");
      const restored = parseSidebarFile(
        await readFile(options.backup, "utf-8")
      );
      const backup = await replaceSidebarFile(statePath, original, restored);
      process.stdout.write(
        `Restored and verified. Previous state backup: ${backup}\n`
      );
    });
  await program.parseAsync([...argv]);
};

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  try {
    await runSidebarSync();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Sidebar sync failed"}\n`
    );
    process.exitCode = 1;
  }
}
