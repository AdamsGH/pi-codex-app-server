import { randomUUID } from "node:crypto";
import path from "node:path";

import { z } from "zod";

export const sidebarSnapshotThreadSchema = z.object({
  archived: z.boolean().default(false),
  id: z.string().min(1),
  projectId: z.string().nullable(),
  updatedAt: z.number().int().nonnegative(),
});

export const sidebarSnapshotSchema = z.object({
  projects: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string(),
      roots: z.array(z.object({ path: z.string().min(1) })).length(1),
    })
  ),
  schemaVersion: z.literal(2),
  sectionId: z.string().nullable(),
  sourceHome: z.string(),
  threads: z.array(sidebarSnapshotThreadSchema),
});
export type SidebarSnapshot = z.infer<typeof sidebarSnapshotSchema>;

const sectionSchema = z.looseObject({
  hostSectionIds: z.record(z.string(), z.string()).optional(),
  id: z.string(),
  itemKeys: z.array(z.string()).default([]),
  name: z.string(),
});
const accountSchema = z.looseObject({
  sectionOrder: z.array(z.string()).default([]),
  sections: z.array(sectionSchema),
  threadHostIds: z.record(z.string(), z.string()).default({}),
});
export const sidebarStateSchema = z.looseObject({
  "app-server-project-id-by-legacy-project-id-by-host": z
    .record(z.string(), z.record(z.string(), z.string()))
    .default({}),
  "electron-persisted-atom-state": z
    .looseObject({
      "sidebar-custom-sections-v3": z
        .record(z.string(), accountSchema)
        .default({}),
    })
    .default({ "sidebar-custom-sections-v3": {} }),
  "pinned-thread-ids": z.array(z.string()).default([]),
  "project-order": z.array(z.string()).default([]),
  "projectless-thread-ids": z.array(z.string()).default([]),
  "remote-projects": z
    .array(
      z.looseObject({
        hostId: z.string(),
        id: z.string(),
        label: z.string().optional(),
        remotePath: z.string(),
      })
    )
    .default([]),
  "thread-project-assignments": z
    .record(
      z.string(),
      z.looseObject({
        hostId: z.string().optional(),
        projectId: z.string(),
        projectKind: z.string(),
      })
    )
    .default({}),
  "thread-project-membership-host-ids": z
    .record(z.string(), z.string())
    .default({}),
});

export interface SidebarImportOptions {
  accountId?: string;
  hostId: string;
  sectionName: string;
}

const windowsRootPattern = /^(?:[a-z]:[\\/]|\\\\)/iu;

const rootKey = (root: string): string => {
  const normalized = windowsRootPattern.test(root)
    ? path.win32.normalize(root).replaceAll("\\", "/").toLowerCase()
    : path.posix.normalize(root);
  return normalized.length > 1 && normalized.endsWith("/")
    ? normalized.slice(0, -1)
    : normalized;
};

export type SidebarState = z.infer<typeof sidebarStateSchema>;

export const inferSidebarHost = (
  state: SidebarState,
  snapshot: SidebarSnapshot,
  accountId?: string
): string => {
  const accounts =
    state["electron-persisted-atom-state"]["sidebar-custom-sections-v3"];
  if (accountId && !accounts[accountId]) {
    throw new Error(`Unknown sidebar account: ${accountId}`);
  }
  const hosts = new Set<string>();
  const addHost = (host: string | undefined): void => {
    if (host && host !== "local") {
      hosts.add(host);
    }
  };
  const selected = Object.entries(accounts).filter(
    ([id]) => !accountId || id === accountId
  );
  for (const [, account] of selected) {
    for (const section of account.sections) {
      for (const [host, sectionId] of Object.entries(
        section.hostSectionIds ?? {}
      )) {
        if (snapshot.sectionId && sectionId === snapshot.sectionId) {
          addHost(host);
        }
      }
    }
    for (const thread of snapshot.threads) {
      const host = account.threadHostIds[thread.id];
      addHost(host);
    }
  }
  for (const thread of snapshot.threads) {
    const assignment = state["thread-project-assignments"][thread.id];
    for (const host of [
      assignment?.hostId,
      state["thread-project-membership-host-ids"][thread.id],
    ]) {
      addHost(host);
    }
  }
  const [host] = hosts;
  if (hosts.size !== 1 || !host) {
    throw new Error(
      "Cannot infer a unique sidebar host. Set PI_CODEX_HOST_ID or pass --host-id with the connected host ID."
    );
  }
  return host;
};
type SidebarAccount = z.infer<typeof accountSchema>;
type SidebarSection = z.infer<typeof sectionSchema>;

const destination = (
  state: SidebarState,
  snapshot: SidebarSnapshot,
  options: SidebarImportOptions
) => {
  const accounts =
    state["electron-persisted-atom-state"]["sidebar-custom-sections-v3"];
  const ids = Object.keys(accounts);
  const accountId =
    options.accountId ?? (ids.length === 1 ? ids[0] : undefined);
  if (!accountId) {
    throw new Error(
      "Specify --account-id when the sidebar has zero or multiple accounts"
    );
  }
  if (ids.length > 0 && !accounts[accountId]) {
    throw new Error(`Unknown sidebar account: ${accountId}`);
  }
  const account = accounts[accountId] ?? {
    sectionOrder: [],
    sections: [],
    threadHostIds: {},
  };
  accounts[accountId] = account;
  const matching = account.sections.filter(
    ({ name }) => name === options.sectionName
  );
  if (matching.length > 1) {
    throw new Error(`Multiple sections named ${options.sectionName}`);
  }
  let [section] = matching;
  if (!section) {
    section = { id: randomUUID(), itemKeys: [], name: options.sectionName };
    account.sections.push(section);
    account.sectionOrder.push(section.id);
  }
  if (snapshot.sectionId) {
    section.hostSectionIds = {
      ...section.hostSectionIds,
      [options.hostId]: snapshot.sectionId,
    };
  }
  return { account, accountId, section };
};

const registerProjects = (
  state: SidebarState,
  snapshot: SidebarSnapshot,
  options: SidebarImportOptions
) => {
  const projectIds = new Map<string, string>();
  let createdProjects = 0;
  for (const project of snapshot.projects) {
    const [root] = project.roots;
    if (!root) {
      throw new Error(`Project has no root: ${project.id}`);
    }
    const matchingProjects = state["remote-projects"].filter(
      (saved) =>
        saved.hostId === options.hostId &&
        rootKey(saved.remotePath) === rootKey(root.path)
    );
    if (matchingProjects.length > 1) {
      throw new Error(`Multiple saved projects for root: ${root.path}`);
    }
    const [existing] = matchingProjects;
    const id = existing?.id ?? project.id;
    if (!existing) {
      if (
        state["remote-projects"].some((saved) => saved.id === id) ||
        state["project-order"].includes(id)
      ) {
        throw new Error(`Project ID belongs to another saved project: ${id}`);
      }
      state["remote-projects"].push({
        hostId: options.hostId,
        id,
        label: project.name,
        remotePath: root.path,
      });
      createdProjects += 1;
    }
    projectIds.set(project.id, id);
    const sourceKey = `${options.hostId}:${snapshot.sourceHome}`;
    state["app-server-project-id-by-legacy-project-id-by-host"][sourceKey] = {
      ...state["app-server-project-id-by-legacy-project-id-by-host"][sourceKey],
      [id]: project.id,
    };
    if (!state["project-order"].includes(id)) {
      state["project-order"].push(id);
    }
  }
  return { createdProjects, projectIds };
};

const assignThreads = (
  state: SidebarState,
  account: SidebarAccount,
  snapshot: SidebarSnapshot,
  projectIds: Map<string, string>,
  options: SidebarImportOptions
) => {
  const targetThreadIds = new Set(snapshot.threads.map(({ id }) => id));
  for (const id of targetThreadIds) {
    const previous = state["thread-project-assignments"][id];
    const previousHosts = [
      account.threadHostIds[id],
      previous?.hostId,
      state["thread-project-membership-host-ids"][id],
      previous?.projectKind === "local" ? "local" : undefined,
    ];
    if (previousHosts.some((host) => host && host !== options.hostId)) {
      throw new Error(`Sidebar thread belongs to another host: ${id}`);
    }
  }
  const assignedIds = new Set<string>();
  for (const thread of snapshot.threads) {
    if (!thread.projectId) {
      Reflect.deleteProperty(state["thread-project-assignments"], thread.id);
      Reflect.deleteProperty(
        state["thread-project-membership-host-ids"],
        thread.id
      );
      if (!state["projectless-thread-ids"].includes(thread.id)) {
        state["projectless-thread-ids"].push(thread.id);
      }
      continue;
    }
    const projectId = projectIds.get(thread.projectId);
    if (!projectId) {
      throw new Error(`Thread references an unknown project: ${thread.id}`);
    }
    const previous = state["thread-project-assignments"][thread.id];
    const previousHost =
      previous?.hostId ??
      state["thread-project-membership-host-ids"][thread.id];
    if (previousHost && previousHost !== options.hostId) {
      throw new Error(
        `Thread assignment belongs to another host: ${thread.id}`
      );
    }
    state["thread-project-assignments"][thread.id] = {
      ...previous,
      hostId: options.hostId,
      projectId,
      projectKind: "remote",
    };
    state["thread-project-membership-host-ids"][thread.id] = options.hostId;
    assignedIds.add(thread.id);
  }
  return { assignedIds, targetThreadIds };
};

const orderSectionItems = (
  section: SidebarSection,
  snapshot: SidebarSnapshot,
  hostId: string
): void => {
  const timestamps = new Map<string, number>();
  for (const thread of snapshot.threads) {
    timestamps.set(`codex:thread:local:${thread.id}`, thread.updatedAt);
    timestamps.set(`codex:thread:${hostId}:${thread.id}`, thread.updatedAt);
  }
  const chats = section.itemKeys.filter(
    (key) => !key.startsWith("codex:project:")
  );
  const sorted = chats
    .filter((key) => timestamps.has(key))
    .toSorted((a, b) => (timestamps.get(b) ?? 0) - (timestamps.get(a) ?? 0));
  let index = 0;
  section.itemKeys = [
    ...section.itemKeys.filter((key) => key.startsWith("codex:project:")),
    ...chats.map((key) => {
      if (!timestamps.has(key)) {
        return key;
      }
      const sortedKey = sorted[index] ?? key;
      index += 1;
      return sortedKey;
    }),
  ];
};

const placeItems = (
  state: SidebarState,
  account: SidebarAccount,
  section: SidebarSection,
  projectIds: Map<string, string>,
  assignedIds: Set<string>,
  targetThreadIds: Set<string>,
  options: SidebarImportOptions,
  snapshot: SidebarSnapshot
): void => {
  state["projectless-thread-ids"] = state["projectless-thread-ids"].filter(
    (id) => !assignedIds.has(id)
  );
  const targetKeys = new Set(
    [...projectIds.values()].map((id) => `codex:project:${id}`)
  );
  const archivedIds = new Set(
    snapshot.threads.filter(({ archived }) => archived).map(({ id }) => id)
  );
  for (const savedSection of account.sections) {
    savedSection.itemKeys = savedSection.itemKeys.filter((key) => {
      if (targetKeys.has(key)) {
        return savedSection.id === section.id;
      }
      for (const id of targetThreadIds) {
        if (
          key === `codex:thread:${options.hostId}:${id}` ||
          key === `codex:thread:local:${id}`
        ) {
          return (
            savedSection.id === section.id &&
            !assignedIds.has(id) &&
            !archivedIds.has(id)
          );
        }
      }
      return true;
    });
  }
  for (const id of targetThreadIds) {
    if (assignedIds.has(id) || archivedIds.has(id)) {
      Reflect.deleteProperty(account.threadHostIds, id);
    } else {
      const key = `codex:thread:local:${id}`;
      if (!section.itemKeys.includes(key)) {
        section.itemKeys.push(key);
      }
      account.threadHostIds[id] = options.hostId;
    }
  }
  state["pinned-thread-ids"] = state["pinned-thread-ids"].filter(
    (id) => !targetThreadIds.has(id)
  );
  for (const key of targetKeys) {
    if (!section.itemKeys.includes(key)) {
      section.itemKeys.push(key);
    }
  }
  orderSectionItems(section, snapshot, options.hostId);
};

export const planSidebarImport = (
  input: SidebarState,
  snapshot: SidebarSnapshot,
  options: SidebarImportOptions
) => {
  if (options.hostId === "local") {
    throw new Error("Use the connected host ID, not local");
  }
  const state = sidebarStateSchema.parse(input);
  const { accountId, account, section } = destination(state, snapshot, options);
  const { projectIds, createdProjects } = registerProjects(
    state,
    snapshot,
    options
  );
  const { assignedIds, targetThreadIds } = assignThreads(
    state,
    account,
    snapshot,
    projectIds,
    options
  );
  placeItems(
    state,
    account,
    section,
    projectIds,
    assignedIds,
    targetThreadIds,
    options,
    snapshot
  );
  return {
    accountId,
    assignedThreads: assignedIds.size,
    createdProjects,
    projectCount: projectIds.size,
    sectionId: section.id,
    state,
  };
};
