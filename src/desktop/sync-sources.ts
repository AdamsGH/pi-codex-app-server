import { readFile } from "node:fs/promises";

import { z } from "zod";

import { readWslSidebarSnapshot } from "../sidebar/sidebar-export.js";
import { readSidebarSnapshot } from "../sidebar/sidebar-source.js";
import type { SidebarSnapshot } from "../sidebar/sidebar-state.js";
import { reconcileDesktopSidebar } from "./sidebar-reconciler.js";
import type { DesktopInventory } from "./sidebar-reconciler.js";

const sourceSchema = z.union([
  z.strictObject({
    endpoint: z.string().min(1),
    hostId: z.string().trim().min(1),
  }),
  z.strictObject({
    hostId: z.string().trim().min(1),
    wsl: z.strictObject({
      distribution: z.string().trim().min(1),
      repository: z.string().startsWith("/"),
    }),
  }),
]);
export type DesktopSyncSource = z.infer<typeof sourceSchema>;
const settingsSchema = z.object({
  pipe: z.string().min(1).optional(),
  sources: z.array(sourceSchema).min(1).optional(),
});

export const readDesktopSyncSettings = async (
  file: string,
  fallback: DesktopSyncSource
): Promise<{ sources: DesktopSyncSource[]; pipe?: string }> => {
  let sources;
  let pipe;
  try {
    const settings = settingsSchema.parse(
      JSON.parse(await readFile(file, "utf-8"))
    );
    sources = settings.sources ?? [fallback];
    ({ pipe } = settings);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { sources: [fallback] };
    }
    throw new Error("Invalid desktop sync sources configuration", {
      cause: error,
    });
  }
  if (new Set(sources.map((source) => source.hostId)).size !== sources.length) {
    throw new Error("Desktop sync sources must have distinct host IDs");
  }
  if (pipe) {
    return { pipe, sources };
  }
  return { sources };
};

export const readDesktopSyncSnapshot = async (
  source: DesktopSyncSource
): Promise<SidebarSnapshot> => {
  if ("wsl" in source) {
    return await readWslSidebarSnapshot({
      ...source.wsl,
      sectionOnly: true,
      skipEmptyProjects: true,
      timeoutMs: 20_000,
    });
  }
  return await readSidebarSnapshot(source.endpoint, { sectionOnly: true });
};

export const reconcileDesktopSources = async (options: {
  readonly sources: readonly DesktopSyncSource[];
  readonly sectionId: string;
  readonly readSnapshot: (
    source: DesktopSyncSource
  ) => Promise<SidebarSnapshot>;
  readonly readInventory: () => Promise<DesktopInventory>;
  readonly move: (
    hostId: string,
    threadId: string,
    beforeThreadId?: string
  ) => Promise<void>;
}): Promise<{ moved: string[]; failedHosts: string[] }> => {
  const snapshots = await Promise.allSettled(
    options.sources.map(options.readSnapshot)
  );
  const moved: string[] = [];
  const failedHosts: string[] = [];
  for (const [index, source] of options.sources.entries()) {
    const result = snapshots[index];
    if (!result || result.status === "rejected") {
      failedHosts.push(source.hostId);
      continue;
    }
    // Native writes are serialized. An uncertain mutation stops the pass and is reconciled from fresh inventory next time.
    moved.push(
      // oxlint-disable-next-line no-await-in-loop
      ...(await reconcileDesktopSidebar({
        hostId: source.hostId,
        move: async (id, before) => {
          await options.move(source.hostId, id, before);
        },
        readInventory: options.readInventory,
        sectionId: options.sectionId,
        snapshot: result.value,
      }))
    );
  }
  return { failedHosts, moved };
};
