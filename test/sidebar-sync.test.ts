import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import { runSidebarSync } from "../src/sidebar-sync.js";
import { replaceSidebarFile } from "../src/sidebar/sidebar-files.js";
import {
  inferSidebarHost,
  planSidebarImport,
  sidebarSnapshotSchema,
  sidebarStateSchema,
} from "../src/sidebar/sidebar-state.js";

const guard = { assertStopped: vi.fn<() => Promise<void>>() };

const options = { hostId: "remote-control:example", sectionName: "Pi" };
const snapshot = sidebarSnapshotSchema.parse({
  projects: [
    { id: "server-project", name: "Repo", roots: [{ path: "C:\\repo" }] },
  ],
  schemaVersion: 1,
  sectionId: "server-section",
  sourceHome: "C:\\pi",
  threads: [
    { id: "repo-thread", projectId: "server-project" },
    { id: "home-thread", projectId: null },
    { archived: true, id: "archived-thread", projectId: null },
  ],
});
const state = () =>
  sidebarStateSchema.parse({
    "electron-persisted-atom-state": {
      draft: "keep",
      "sidebar-custom-sections-v3": {
        account: {
          sections: [
            {
              id: "pi",
              itemKeys: [
                "codex:thread:local:repo-thread",
                "codex:thread:local:home-thread",
                "codex:thread:local:archived-thread",
              ],
              name: "Pi",
            },
          ],
          threadHostIds: {
            "home-thread": options.hostId,
            "repo-thread": options.hostId,
          },
        },
      },
    },
    "pinned-thread-ids": ["repo-thread", "other-thread"],
    "projectless-thread-ids": ["repo-thread"],
    "remote-projects": [
      {
        hostId: options.hostId,
        id: "saved-project",
        label: "My name",
        remotePath: "c:/REPO/",
      },
      { hostId: "other", id: "other-project", remotePath: "/other" },
    ],
    unrelated: { data: [1, 2] },
  });

describe("Sidebar import", () => {
  test("infers the connected host from imported sessions and rejects conflicting ownership", () => {
    const original = state();
    expect(inferSidebarHost(original, snapshot)).toBe(options.hostId);
    original["thread-project-membership-host-ids"]["repo-thread"] =
      "remote-control:other";
    expect(() => inferSidebarHost(original, snapshot)).toThrow(
      "unique sidebar host"
    );
    expect(() =>
      inferSidebarHost(sidebarStateSchema.parse({}), snapshot)
    ).toThrow("PI_CODEX_HOST_ID");
    expect(() => inferSidebarHost(original, snapshot, "unknown")).toThrow(
      "Unknown sidebar account"
    );
  });

  test("infers a host from its exact source section binding even with no sessions", () => {
    const original = state();
    const section =
      original["electron-persisted-atom-state"]["sidebar-custom-sections-v3"]
        .account?.sections[0];
    if (!section) {
      throw new Error("Fixture has no section");
    }
    section.hostSectionIds = {
      [options.hostId]: snapshot.sectionId ?? "",
    };
    expect(inferSidebarHost(original, { ...snapshot, threads: [] })).toBe(
      options.hostId
    );
  });

  test("rejects a flag consumed as a missing host value before checking desktop processes", async () => {
    await expect(
      runSidebarSync(["node", "sidebar-sync", "sync", "--host-id", "--dry-run"])
    ).rejects.toThrow("--host-id requires a remote host ID");
  });

  test("reuses host/root projects, preserves unknown state, and is idempotent", () => {
    const original = state();
    const first = planSidebarImport(original, snapshot, options);
    const second = planSidebarImport(first.state, snapshot, options);
    expect(second.state).toStrictEqual(first.state);
    expect(first).toMatchObject({
      assignedThreads: 1,
      createdProjects: 0,
      projectCount: 1,
      state: {
        "pinned-thread-ids": ["other-thread"],
        "remote-projects": [{ label: "My name" }, { id: "other-project" }],
        unrelated: { data: [1, 2] },
      },
    });
    expect(
      first.state["thread-project-assignments"]["repo-thread"]
    ).toMatchObject({ hostId: options.hostId, projectId: "saved-project" });
    expect(
      first.state["electron-persisted-atom-state"]["sidebar-custom-sections-v3"]
        .account
    ).toMatchObject({
      sections: [
        {
          hostSectionIds: { [options.hostId]: "server-section" },
          itemKeys: [
            "codex:thread:local:home-thread",
            "codex:project:saved-project",
          ],
        },
      ],
      threadHostIds: { "home-thread": options.hostId },
    });
    expect(original).toStrictEqual(state());
  });

  test("rejects cross-host ownership and unknown account selection", () => {
    const original = state();
    original["thread-project-assignments"]["home-thread"] = {
      hostId: "other",
      projectId: "other-project",
      projectKind: "remote",
    };
    expect(() => planSidebarImport(original, snapshot, options)).toThrow(
      "another host"
    );
    expect(() =>
      planSidebarImport(state(), snapshot, { ...options, accountId: "typo" })
    ).toThrow("Unknown sidebar account");
    expect(() =>
      planSidebarImport(sidebarStateSchema.parse({}), snapshot, options)
    ).toThrow("--account-id");
  });

  test("backs up the original and verifies the replacement on disk", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-sidebar-file-"));
    try {
      guard.assertStopped.mockResolvedValue();
      const target = path.join(directory, "state.json");
      const original = JSON.stringify(state());
      await writeFile(target, original);
      const plan = planSidebarImport(state(), snapshot, options);
      const backup = await replaceSidebarFile(
        target,
        original,
        plan.state,
        guard
      );
      await expect(readFile(backup, "utf-8")).resolves.toBe(original);
      expect(JSON.parse(await readFile(target, "utf-8"))).toStrictEqual(
        plan.state
      );
      const files = await readdir(directory);
      expect(
        files.filter((name) => name.endsWith(".tmp") || name.endsWith(".lock"))
      ).toStrictEqual([]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("refuses a stale plan and an app opening before replacement", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-sidebar-race-"));
    try {
      const target = path.join(directory, "state.json");
      const original = JSON.stringify(state());
      await writeFile(target, original);
      guard.assertStopped.mockReset().mockResolvedValue();
      await expect(
        replaceSidebarFile(target, "stale", state(), guard)
      ).rejects.toThrow("changed after planning");
      guard.assertStopped
        .mockReset()
        .mockResolvedValueOnce()
        .mockRejectedValueOnce(new Error("Codex opened"));
      await expect(
        replaceSidebarFile(target, original, state(), guard)
      ).rejects.toThrow("Codex opened");
      await expect(readFile(target, "utf-8")).resolves.toBe(original);
      const files = await readdir(directory);
      expect(
        files.filter((name) => name.endsWith(".tmp") || name.endsWith(".lock"))
      ).toStrictEqual([]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
