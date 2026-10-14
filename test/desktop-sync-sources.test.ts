import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import type { DesktopInventory } from "../src/desktop/sidebar-reconciler.js";
import {
  readDesktopSyncSettings,
  reconcileDesktopSources,
} from "../src/desktop/sync-sources.js";
import type { DesktopSyncSource } from "../src/desktop/sync-sources.js";
import { sidebarSnapshotSchema } from "../src/sidebar/sidebar-state.js";

const sources: DesktopSyncSource[] = [
  { endpoint: "/endpoint.json", hostId: "windows" },
  { hostId: "wsl", wsl: { distribution: "Test", repository: "/repo" } },
];
const snapshot = (id: string) =>
  sidebarSnapshotSchema.parse({
    projects: [],
    schemaVersion: 2,
    sectionId: "pi-source",
    sourceHome: "/test",
    threads: [{ id, projectId: null, updatedAt: 1 }],
  });
const fixture = () => {
  const keys: string[] = [];
  const state: DesktopInventory = {
    sections: [{ itemKeys: keys, name: "Pi", sectionId: "pi" }],
  };
  const move = vi.fn<
    (host: string, id: string, before?: string) => Promise<void>
  >((_host, id) => {
    keys.push(`codex:thread:local:${id}`);
    return Promise.resolve();
  });
  return {
    keys,
    move,
    options: {
      move,
      readInventory: () => Promise.resolve(state),
      readSnapshot: (source: DesktopSyncSource) =>
        Promise.resolve(snapshot(source.hostId)),
      sectionId: "pi",
      sources,
    },
  };
};

describe("Desktop sync sources", () => {
  test("reloads multiple host sources and retains legacy single-host configuration", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "desktop-sources-"));
    const file = path.join(dir, "desktop-sync.json");
    const fallback: DesktopSyncSource = {
      endpoint: "/legacy",
      hostId: "legacy",
    };
    try {
      await expect(
        readDesktopSyncSettings(file, fallback)
      ).resolves.toStrictEqual({ sources: [fallback] });
      await writeFile(
        file,
        JSON.stringify({ enabled: true, hostId: "legacy" })
      );
      await expect(
        readDesktopSyncSettings(file, fallback)
      ).resolves.toStrictEqual({ sources: [fallback] });
      await writeFile(file, JSON.stringify({ pipe: "test-endpoint", sources }));
      await expect(
        readDesktopSyncSettings(file, fallback)
      ).resolves.toStrictEqual({ pipe: "test-endpoint", sources });
      await writeFile(file, JSON.stringify({ sources: [fallback, fallback] }));
      await expect(readDesktopSyncSettings(file, fallback)).rejects.toThrow(
        "distinct host IDs"
      );
      await writeFile(
        file,
        JSON.stringify({
          sources: [
            {
              hostId: "bad",
              wsl: { distribution: "Test", repository: "relative" },
            },
          ],
        })
      );
      await expect(readDesktopSyncSettings(file, fallback)).rejects.toThrow(
        "Invalid desktop sync sources"
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("places both Windows and WSL chats through the desktop host with correct ownership", async () => {
    const f = fixture();
    await expect(reconcileDesktopSources(f.options)).resolves.toStrictEqual({
      failedHosts: [],
      moved: ["windows", "wsl"],
    });
    expect(f.move.mock.calls).toStrictEqual([
      ["windows", "windows", undefined],
      ["wsl", "wsl", undefined],
    ]);
    await expect(reconcileDesktopSources(f.options)).resolves.toStrictEqual({
      failedHosts: [],
      moved: [],
    });
    expect(f.move).toHaveBeenCalledTimes(2);
  });

  test("an unavailable source does not prevent another host from synchronizing", async () => {
    const f = fixture();
    await expect(
      reconcileDesktopSources({
        ...f.options,
        readSnapshot: (source) => {
          if (source.hostId === "wsl") {
            return Promise.reject(new Error("Unavailable"));
          }
          return Promise.resolve(snapshot(source.hostId));
        },
      })
    ).resolves.toStrictEqual({ failedHosts: ["wsl"], moved: ["windows"] });
    expect(f.move.mock.calls).toStrictEqual([
      ["windows", "windows", undefined],
    ]);
  });

  test("does not replay an uncertain WSL mutation after Windows was synchronized", async () => {
    const f = fixture();
    const move = vi.fn<
      (host: string, id: string, before?: string) => Promise<void>
    >(async (host, id, before) => {
      await f.move(host, id, before);
      if (host === "wsl") {
        throw new Error("Uncertain write");
      }
    });
    await expect(
      reconcileDesktopSources({ ...f.options, move })
    ).rejects.toThrow("Uncertain write");
    await expect(
      reconcileDesktopSources({ ...f.options, move })
    ).resolves.toStrictEqual({ failedHosts: [], moved: [] });
    expect(move).toHaveBeenCalledTimes(2);
  });
});
