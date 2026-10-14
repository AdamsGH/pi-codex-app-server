import { z } from "zod";

import type { SidebarSnapshot } from "../sidebar/sidebar-state.js";

export const desktopInventorySchema = z.object({
  pinnedThreads: z
    .array(
      z.object({
        hostId: z.string().optional(),
        id: z.string(),
        updatedAt: z.number().finite().optional(),
      })
    )
    .optional(),
  sections: z.array(
    z.object({
      itemKeys: z.array(z.string()),
      name: z.string(),
      sectionId: z.string(),
    })
  ),
  sidebarPreferences: z
    .object({
      sorting: z
        .object({ chats: z.enum(["manual", "updated_at"]).optional() })
        .optional(),
    })
    .optional(),
  threads: z
    .array(
      z.object({
        hostId: z.string().optional(),
        id: z.string(),
        updatedAt: z.number().finite().optional(),
      })
    )
    .optional(),
  unavailableHosts: z.array(z.unknown()).optional(),
});
export type DesktopInventory = z.infer<typeof desktopInventorySchema>;

const includesThread = (keys: readonly string[], id: string): boolean =>
  keys.some((key) => key.startsWith("codex:thread:") && key.endsWith(`:${id}`));

const sectionThreadIds = (keys: readonly string[]): string[] =>
  keys.flatMap((key) => {
    if (
      key.startsWith("codex:thread:") ||
      key.startsWith("chatgpt:conversation:")
    ) {
      return [key.slice(key.lastIndexOf(":") + 1)];
    }
    return [];
  });

export const reconcileDesktopSectionOrder = async (options: {
  readonly sectionId: string;
  readonly readInventory: () => Promise<DesktopInventory>;
  readonly reorder: (threadIds: string[]) => Promise<void>;
}): Promise<boolean> => {
  const inventory = await options.readInventory();
  if (
    inventory.sidebarPreferences?.sorting?.chats !== "updated_at" ||
    inventory.unavailableHosts?.length
  ) {
    return false;
  }
  const section = inventory.sections.find(
    (entry) => entry.sectionId === options.sectionId
  );
  if (!section) {
    throw new Error("Configured desktop section is unavailable");
  }
  const current = sectionThreadIds(section.itemKeys);
  if (new Set(current).size !== current.length) {
    throw new Error("Desktop section contains ambiguous thread identities");
  }
  // list_threads returns a bounded recent window across hosts. Older, unseen entries retain their relative order.
  const activity = new Map(
    (inventory.threads ?? []).flatMap((thread) =>
      thread.updatedAt === undefined
        ? []
        : [[thread.id, thread.updatedAt] as const]
    )
  );
  const ordered = current.toSorted((left, right) => {
    const a = activity.get(left);
    const b = activity.get(right);
    if (a === undefined) {
      return b === undefined ? 0 : 1;
    }
    if (b === undefined) {
      return -1;
    }
    return b - a;
  });
  if (ordered.every((id, index) => current[index] === id)) {
    return false;
  }
  await options.reorder(ordered);
  const after = await options.readInventory();
  const verified = after.sections.find(
    (entry) => entry.sectionId === options.sectionId
  );
  const actual = sectionThreadIds(verified?.itemKeys ?? []);
  if (
    actual.length !== ordered.length ||
    actual.some((id, index) => ordered[index] !== id)
  ) {
    throw new Error("Desktop did not confirm section order");
  }
  return true;
};

export const reconcileDesktopSidebar = async (options: {
  readonly hostId: string;
  readonly snapshot: SidebarSnapshot;
  readonly sectionId: string;
  readonly readInventory: () => Promise<DesktopInventory>;
  readonly move: (threadId: string, beforeThreadId?: string) => Promise<void>;
}): Promise<string[]> => {
  let inventory = await options.readInventory();
  const moved: string[] = [];
  const candidates = options.snapshot.threads
    .filter((thread) => !thread.archived && !thread.projectId)
    .toSorted((left, right) => left.updatedAt - right.updatedAt);
  const sourceIds = new Set(
    options.snapshot.threads.map((thread) => thread.id)
  );
  for (const thread of candidates) {
    const desktopThread = [
      ...(inventory.threads ?? []),
      ...(inventory.pinnedThreads ?? []),
    ].find((entry) => entry.id === thread.id);
    if (desktopThread?.hostId && desktopThread.hostId !== options.hostId) {
      throw new Error(
        `Desktop thread identity belongs to another host: ${thread.id}`
      );
    }
    const destination = inventory.sections.find(
      (section) => section.sectionId === options.sectionId
    );
    if (!destination) {
      throw new Error("Configured desktop section is unavailable");
    }
    if (
      inventory.sections.some(
        (section) =>
          section.sectionId !== "chats" &&
          section.sectionId !== "threads" &&
          includesThread(section.itemKeys, thread.id)
      )
    ) {
      continue;
    }
    // Desktop keys can use a canonical local alias for remote threads. Only backend-owned IDs are valid anchors.
    const firstKey = destination.itemKeys.find(
      (key) =>
        key.startsWith("codex:thread:") &&
        sourceIds.has(key.slice(key.lastIndexOf(":") + 1))
    );
    const beforeThreadId = firstKey?.slice(firstKey.lastIndexOf(":") + 1);
    // A timeout leaves an unknown write outcome. The next pass reads inventory before another move.
    // oxlint-disable-next-line no-await-in-loop
    await options.move(thread.id, beforeThreadId);
    // oxlint-disable-next-line no-await-in-loop
    inventory = await options.readInventory();
    const verified = inventory.sections.find(
      (section) => section.sectionId === options.sectionId
    );
    if (!verified || !includesThread(verified.itemKeys, thread.id)) {
      throw new Error(
        `Desktop did not confirm section membership: ${thread.id}`
      );
    }
    moved.push(thread.id);
  }
  return moved;
};
