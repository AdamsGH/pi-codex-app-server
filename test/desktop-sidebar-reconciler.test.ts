import { describe, expect, it, vi } from "vitest";

import {
  desktopInventorySchema,
  reconcileDesktopSidebar,
  reconcileDesktopSectionOrder,
} from "../src/desktop/sidebar-reconciler.js";
import type { DesktopInventory } from "../src/desktop/sidebar-reconciler.js";
import type { SidebarSnapshot } from "../src/sidebar/sidebar-state.js";

const snapshot: SidebarSnapshot = {
  projects: [],
  schemaVersion: 2,
  sectionId: "server-pi",
  sourceHome: "test",
  threads: [
    { archived: false, id: "new", projectId: null, updatedAt: 2 },
    { archived: false, id: "old", projectId: null, updatedAt: 1 },
    { archived: false, id: "project", projectId: "project-id", updatedAt: 3 },
    { archived: true, id: "archived", projectId: null, updatedAt: 4 },
  ],
};
const key = (id: string) => `codex:thread:local:${id}`;
const inventory = (): DesktopInventory => ({
  sections: [
    {
      itemKeys: ["codex:project:repo", key("old")],
      name: "Pi",
      sectionId: "pi",
    },
    { itemKeys: [], name: "Tasks", sectionId: "chats" },
  ],
});

describe("desktop sidebar reconciliation", () => {
  it("orders recent chats across hosts while retaining older entries and project slots", async () => {
    const state = inventory();
    state.sidebarPreferences = { sorting: { chats: "updated_at" } };
    state.sections[0]?.itemKeys.splice(
      0,
      state.sections[0].itemKeys.length,
      "codex:project:repo",
      key("unknown-a"),
      key("old"),
      key("wsl"),
      key("unknown-b")
    );
    state.threads = [
      { hostId: "windows", id: "old", updatedAt: 1 },
      { hostId: "wsl", id: "wsl", updatedAt: 2 },
    ];
    const reorder = vi.fn<(ids: string[]) => Promise<void>>((ids) => {
      state.sections[0]?.itemKeys.splice(
        0,
        state.sections[0].itemKeys.length,
        "codex:project:repo",
        ...ids.map(key)
      );
      return Promise.resolve();
    });
    const options = {
      readInventory: () => Promise.resolve(state),
      reorder,
      sectionId: "pi",
    };
    await expect(reconcileDesktopSectionOrder(options)).resolves.toBeTruthy();
    expect(reorder).toHaveBeenCalledExactlyOnceWith([
      "wsl",
      "old",
      "unknown-a",
      "unknown-b",
    ]);
    await expect(reconcileDesktopSectionOrder(options)).resolves.toBeFalsy();
    expect(reorder).toHaveBeenCalledOnce();
  });

  it("preserves manual sorting", async () => {
    const state = inventory();
    state.sidebarPreferences = { sorting: { chats: "manual" } };
    const reorder = vi
      .fn<(ids: string[]) => Promise<void>>()
      .mockResolvedValue();
    await expect(
      reconcileDesktopSectionOrder({
        readInventory: () => Promise.resolve(state),
        reorder,
        sectionId: "pi",
      })
    ).resolves.toBeFalsy();
    expect(reorder).not.toHaveBeenCalled();
  });

  it("reconciles an uncertain reorder without replay and verifies confirmed writes", async () => {
    const state = inventory();
    state.sidebarPreferences = { sorting: { chats: "updated_at" } };
    state.sections[0]?.itemKeys.push(key("new"));
    state.threads = [
      { id: "new", updatedAt: 2 },
      { id: "old", updatedAt: 1 },
    ];
    const reorder = vi.fn<(ids: string[]) => Promise<void>>((ids) => {
      state.sections[0]?.itemKeys.splice(
        0,
        state.sections[0].itemKeys.length,
        ...ids.map(key)
      );
      return Promise.reject(new Error("Write deadline expired"));
    });
    const options = {
      readInventory: () => Promise.resolve(state),
      reorder,
      sectionId: "pi",
    };
    await expect(reconcileDesktopSectionOrder(options)).rejects.toThrow(
      "deadline"
    );
    await expect(reconcileDesktopSectionOrder(options)).resolves.toBeFalsy();
    expect(reorder).toHaveBeenCalledOnce();
    state.sections[0]?.itemKeys.reverse();
    await expect(
      reconcileDesktopSectionOrder({ ...options, reorder: async () => {} })
    ).rejects.toThrow("did not confirm section order");
  });

  it("accepts cloud chats that do not have an execution host", () => {
    expect(
      desktopInventorySchema.parse({
        ...inventory(),
        threads: [{ id: "cloud-chat" }],
      }).threads
    ).toStrictEqual([{ id: "cloud-chat" }]);
  });

  it("anchors a move to a thread owned by the same backend in a mixed-host section", async () => {
    const state = inventory();
    state.sections[0]?.itemKeys.splice(1, 0, key("foreign"));
    const move = vi.fn<(id: string, before?: string) => Promise<void>>((id) => {
      state.sections[0]?.itemKeys.push(key(id));
      return Promise.resolve();
    });
    await reconcileDesktopSidebar({
      hostId: "pi-host",
      move,
      readInventory: () => Promise.resolve(state),
      sectionId: "pi",
      snapshot,
    });
    expect(move).toHaveBeenCalledExactlyOnceWith("new", "old");
  });

  it("refuses a colliding desktop thread ID owned by another host", async () => {
    const state = inventory();
    state.sections[0]?.itemKeys.push(key("new"));
    state.threads = [{ hostId: "foreign-host", id: "new" }];
    const move = vi.fn<(id: string, before?: string) => Promise<void>>(() =>
      Promise.resolve()
    );
    await expect(
      reconcileDesktopSidebar({
        hostId: "pi-host",
        move,
        readInventory: () => Promise.resolve(state),
        sectionId: "pi",
        snapshot,
      })
    ).rejects.toThrow("another host");
    expect(move).not.toHaveBeenCalled();
  });

  it("adds missing published chats before existing chats and does not repeat moves", async () => {
    const state = inventory();
    const move = vi.fn<(id: string, beforeThreadId?: string) => Promise<void>>(
      (id) => {
        state.sections[0]?.itemKeys.splice(1, 0, key(id));
        return Promise.resolve();
      }
    );
    const options = {
      hostId: "pi-host",
      move,
      readInventory: () => Promise.resolve(state),
      sectionId: "pi",
      snapshot,
    };
    await expect(reconcileDesktopSidebar(options)).resolves.toStrictEqual([
      "new",
    ]);
    expect(move).toHaveBeenCalledExactlyOnceWith("new", "old");
    expect(state.sections[0]?.itemKeys).toStrictEqual([
      "codex:project:repo",
      key("new"),
      key("old"),
    ]);
    await expect(reconcileDesktopSidebar(options)).resolves.toStrictEqual([]);
    expect(move).toHaveBeenCalledOnce();
  });

  it("preserves explicit placement in another custom section or pinned", async () => {
    const state = inventory();
    state.sections.push({
      itemKeys: [key("new")],
      name: "Pinned",
      sectionId: "pinned",
    });
    const move = vi
      .fn<(id: string, beforeThreadId?: string) => Promise<void>>()
      .mockResolvedValue();
    await expect(
      reconcileDesktopSidebar({
        hostId: "pi-host",
        move,
        readInventory: () => Promise.resolve(state),
        sectionId: "pi",
        snapshot,
      })
    ).resolves.toStrictEqual([]);
    expect(move).not.toHaveBeenCalled();
  });

  it("reads inventory after an uncertain write outcome before retrying", async () => {
    const state = inventory();
    const move = vi.fn<(id: string, beforeThreadId?: string) => Promise<void>>(
      (id) => {
        state.sections[0]?.itemKeys.push(key(id));
        return Promise.reject(new Error("Write deadline expired"));
      }
    );
    const options = {
      hostId: "pi-host",
      move,
      readInventory: () => Promise.resolve(state),
      sectionId: "pi",
      snapshot,
    };
    await expect(reconcileDesktopSidebar(options)).rejects.toThrow("deadline");
    await expect(reconcileDesktopSidebar(options)).resolves.toStrictEqual([]);
    expect(move).toHaveBeenCalledOnce();
  });

  it("requires desktop membership confirmation after a successful operation", async () => {
    await expect(
      reconcileDesktopSidebar({
        hostId: "pi-host",
        move: vi
          .fn<(id: string, beforeThreadId?: string) => Promise<void>>()
          .mockResolvedValue(),
        readInventory: () => Promise.resolve(inventory()),
        sectionId: "pi",
        snapshot,
      })
    ).rejects.toThrow("did not confirm");
  });

  it("refuses writes when the configured desktop section is missing", async () => {
    const move = vi
      .fn<(id: string, beforeThreadId?: string) => Promise<void>>()
      .mockResolvedValue();
    await expect(
      reconcileDesktopSidebar({
        hostId: "pi-host",
        move,
        readInventory: () => Promise.resolve(inventory()),
        sectionId: "missing",
        snapshot,
      })
    ).rejects.toThrow("unavailable");
    expect(move).not.toHaveBeenCalled();
  });
});
