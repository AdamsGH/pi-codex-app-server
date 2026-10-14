import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { Command } from "commander";
import { lock } from "proper-lockfile";
import { z } from "zod";

import { resolveDesktopEndpoint } from "./desktop/desktop-endpoint.js";
import { DesktopNativeTools } from "./desktop/native-tools.js";
import {
  desktopInventorySchema,
  reconcileDesktopSidebar,
  reconcileDesktopSectionOrder,
} from "./desktop/sidebar-reconciler.js";
import { readSidebarSnapshot } from "./sidebar/sidebar-source.js";

interface SidebarMoveArguments {
  hostId: string;
  sectionId: string;
  threadId: string;
  beforeThreadId?: string;
}
const serverHome =
  process.env.PI_CODEX_APP_SERVER_HOME ??
  path.join(
    process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi", "agent"),
    "codex-app-server"
  );

const options = new Command()
  .name("pi-codex-desktop-sync")
  .description("Reconcile published Pi chats through native desktop host tools")
  .requiredOption(
    "--host-id <id>",
    "Connected Pi host owning published sessions"
  )
  .requiredOption("--section-id <id>", "Destination desktop custom section")
  .option(
    "--caller-thread-id <id>",
    "Actual local caller task",
    process.env.CODEX_THREAD_ID
  )
  .option(
    "--pipe <path>",
    "Desktop-provided host-tools endpoint",
    process.env.CODEX_APP_TOOLS_PIPE_PATH
  )
  .option(
    "--endpoint <path>",
    "Pi endpoint file or WebSocket URL",
    path.join(serverHome, "endpoint.json")
  )
  .option("--once", "Reconcile once and exit", false)
  .parse()
  .opts<{
    hostId: string;
    sectionId: string;
    callerThreadId?: string;
    pipe?: string;
    endpoint: string;
    once: boolean;
  }>();

if (!options.callerThreadId) {
  throw new Error(
    "Supply the actual caller task through CODEX_THREAD_ID or --caller-thread-id"
  );
}
const caller = { threadId: options.callerThreadId };
const release = await lock(serverHome, {
  lockfilePath: path.join(serverHome, "desktop-sync.lock"),
  retries: options.once
    ? 0
    : { maxTimeout: 1000, minTimeout: 500, retries: 10 },
  stale: 10_000,
  update: 2000,
});
const abort = new AbortController();
process.once("SIGINT", () => abort.abort());
process.once("SIGTERM", () => abort.abort());
process.once("disconnect", () => abort.abort());
let client: DesktopNativeTools | undefined;
let endpoint: string | undefined;
let lastError: string | undefined;
try {
  do {
    try {
      // Resolve again after failures because desktop owns the pipe lifetime.
      // oxlint-disable-next-line no-await-in-loop
      const current = await resolveDesktopEndpoint(endpoint ?? options.pipe);
      if (current !== endpoint || !client) {
        client?.close();
        client = new DesktopNativeTools(current, { timeoutMs: 45_000 });
        endpoint = current;
        // oxlint-disable-next-line no-await-in-loop
        const tools = await client.listTools();
        for (const name of [
          "list_threads",
          "move_thread_to_sidebar_section",
          "reorder_section",
        ]) {
          if (
            !tools.some(
              (tool) => tool.name === name && tool.namespace === "codex_app"
            )
          ) {
            throw new Error(`Desktop lacks required capability: ${name}`);
          }
        }
      }
      const desktop = client;
      // oxlint-disable-next-line no-await-in-loop
      const snapshot = await readSidebarSnapshot(options.endpoint, {
        sectionOnly: true,
      });
      // oxlint-disable-next-line no-await-in-loop
      const moved = await reconcileDesktopSidebar({
        hostId: options.hostId,
        move: async (threadId, beforeThreadId) => {
          const args: SidebarMoveArguments = {
            hostId: options.hostId,
            sectionId: options.sectionId,
            threadId,
          };
          if (beforeThreadId) {
            args.beforeThreadId = beforeThreadId;
          }
          await desktop.call(
            "move_thread_to_sidebar_section",
            z.json().parse(args),
            caller
          );
        },
        readInventory: async () =>
          desktopInventorySchema.parse(
            await desktop.call("list_threads", { limit: 50 }, caller)
          ),
        sectionId: options.sectionId,
        snapshot,
      });
      // oxlint-disable-next-line no-await-in-loop
      const reordered = await reconcileDesktopSectionOrder({
        readInventory: async () =>
          desktopInventorySchema.parse(
            await desktop.call("list_threads", { limit: 50 }, caller)
          ),
        reorder: async (threadIds) => {
          await desktop.call(
            "reorder_section",
            { sectionId: options.sectionId, threadIds },
            caller
          );
        },
        sectionId: options.sectionId,
      });
      if (moved.length || reordered || options.once || lastError) {
        process.stdout.write(
          `${JSON.stringify({ status: "connected", synchronized: moved })}\n`
        );
      }
      lastError = undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      client?.close();
      client = undefined;
      if (message !== lastError) {
        process.stderr.write(`${message}\n`);
        lastError = message;
      }
      if (options.once) {
        process.exitCode = 1;
      }
    }
    if (!options.once && !abort.signal.aborted) {
      // oxlint-disable-next-line no-await-in-loop
      await delay(5000, undefined, { signal: abort.signal }).catch(
        (error: Error) => {
          if (!abort.signal.aborted) {
            throw error;
          }
        }
      );
    }
  } while (!options.once && !abort.signal.aborted);
} finally {
  client?.close();
  await release();
}
