import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { Command } from "commander";
import { z } from "zod";

import { assertDesktopStopped } from "./sidebar/desktop-processes.js";
import {
  filterSidebarProjects,
  readWslSidebarSnapshot,
  saveSidebarSnapshot,
} from "./sidebar/sidebar-export.js";
import {
  parseSidebarFile,
  replaceSidebarFile,
} from "./sidebar/sidebar-files.js";
import { readSidebarSnapshot } from "./sidebar/sidebar-source.js";
import {
  planSidebarImport,
  inferSidebarHost,
  sidebarSnapshotSchema,
} from "./sidebar/sidebar-state.js";
import type { SidebarSnapshot } from "./sidebar/sidebar-state.js";

const defaultHome = process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
const defaultEndpoint =
  process.env.PI_SIDEBAR_ENDPOINT ??
  path.join(
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
  hostId: z
    .string()
    .refine(
      (value) =>
        value.length > 0 && value !== "local" && !value.startsWith("-"),
      "--host-id requires a remote host ID, not another option"
    )
    .optional(),
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
  const state = parseSidebarFile(original);
  const hostId =
    options.hostId ?? inferSidebarHost(state, snapshot, options.accountId);
  const plan = planSidebarImport(state, sidebarSnapshotSchema.parse(snapshot), {
    accountId: options.accountId,
    hostId,
    sectionName: options.section,
  });
  process.stdout.write(
    `${JSON.stringify({ accountId: plan.accountId, assignedThreads: plan.assignedThreads, createdProjects: plan.createdProjects, dryRun: options.dryRun, hostId, projectCount: plan.projectCount, section: options.section, statePath, withdrawnThreads: plan.withdrawnThreads }, null, 2)}\n`
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
    .option("--output <file>", "Snapshot to create")
    .option("--stdout", "Write only snapshot JSON to stdout", false)
    .option(
      "--section-only",
      "Export only unarchived members of the Pi server section",
      false
    )
    .option(
      "--skip-empty-projects",
      "Export only projects referenced by published sessions",
      false
    )
    .option("--overwrite", "Atomically replace an existing snapshot", false)
    .action(
      async (options: {
        endpoint: string;
        output?: string;
        overwrite: boolean;
        stdout: boolean;
        skipEmptyProjects: boolean;
        sectionOnly: boolean;
      }) => {
        if (options.stdout === Boolean(options.output)) {
          throw new Error("Specify exactly one of --output or --stdout");
        }
        const snapshot = filterSidebarProjects(
          await readSidebarSnapshot(options.endpoint, {
            sectionOnly: options.sectionOnly,
          }),
          options.skipEmptyProjects
        );
        if (options.stdout) {
          process.stdout.write(`${JSON.stringify(snapshot)}\n`);
          return;
        }
        await saveSidebarSnapshot(
          snapshot,
          z.string().parse(options.output),
          options.overwrite
        );
        process.stdout.write(
          `Exported ${snapshot.projects.length} projects and ${snapshot.threads.length} sessions to ${options.output}\n`
        );
      }
    );
  program
    .command("export-wsl")
    .requiredOption(
      "--distribution <name>",
      "WSL distribution containing the Pi daemon"
    )
    .requiredOption(
      "--repository <path>",
      "Built repository checkout inside WSL"
    )
    .requiredOption("--output <file>", "Local snapshot to create")
    .option(
      "--skip-empty-projects",
      "Export only projects referenced by published sessions",
      false
    )
    .option("--overwrite", "Atomically replace an existing snapshot", false)
    .action(
      async (options: {
        distribution: string;
        repository: string;
        output: string;
        overwrite: boolean;
        skipEmptyProjects: boolean;
      }) => {
        const snapshot = await readWslSidebarSnapshot(options);
        await saveSidebarSnapshot(snapshot, options.output, options.overwrite);
        process.stdout.write(
          `Exported ${snapshot.projects.length} projects and ${snapshot.threads.length} sessions to ${options.output}\n`
        );
      }
    );
  const addImportOptions = (command: Command): Command =>
    command
      .option(
        "--host-id <id>",
        "Connected host ID; inferred from imported sessions when omitted",
        process.env.PI_CODEX_HOST_ID
      )
      .option(
        "--codex-home <directory>",
        "Desktop state directory",
        defaultHome
      )
      .option(
        "--section <name>",
        "Destination sidebar section",
        process.env.PI_SIDEBAR_SECTION ?? "Pi"
      )
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
    const parsed = importOptionsSchema.parse(options);
    if (!parsed.dryRun) {
      await assertDesktopStopped();
    }
    await applySnapshot(await readSidebarSnapshot(options.endpoint), parsed);
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
