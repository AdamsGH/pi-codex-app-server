import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import { runSidebarSync } from "../src/sidebar-sync.js";
import {
  filterSidebarProjects,
  readWslSidebarSnapshot,
  saveSidebarSnapshot,
} from "../src/sidebar/sidebar-export.js";
import { sidebarSnapshotSchema } from "../src/sidebar/sidebar-state.js";

const snapshot = sidebarSnapshotSchema.parse({
  projects: [
    { id: "used", name: "Used", roots: [{ path: "/used" }] },
    { id: "empty", name: "Empty", roots: [{ path: "/empty" }] },
  ],
  schemaVersion: 2,
  sectionId: "pi",
  sourceHome: "/pi",
  threads: [{ id: "thread", projectId: "used", updatedAt: 1 }],
});

describe("Sidebar export", () => {
  test("omits empty projects without changing publication or the original snapshot", () => {
    const filtered = filterSidebarProjects(snapshot, true);
    expect(filtered.projects.map((project) => project.id)).toStrictEqual([
      "used",
    ]);
    expect(filtered.threads).toStrictEqual(snapshot.threads);
    expect(snapshot.projects).toHaveLength(2);
    expect(filterSidebarProjects(snapshot, false)).toBe(snapshot);
    expect(
      filterSidebarProjects({ ...snapshot, threads: [] }, true).projects
    ).toStrictEqual([]);
  });

  test("validates a remote snapshot and passes WSL arguments without shell interpretation", async () => {
    const run = vi
      .fn<(...args: unknown[]) => Promise<{ stdout: string }>>()
      .mockResolvedValue({ stdout: JSON.stringify(snapshot) });
    const result = await readWslSidebarSnapshot(
      {
        distribution: "Test Linux",
        repository: "/home/test/repo with spaces",
        skipEmptyProjects: true,
      },
      run
    );
    expect(result.projects).toHaveLength(1);
    expect(run).toHaveBeenCalledExactlyOnceWith(
      "wsl.exe",
      [
        "--distribution",
        "Test Linux",
        "--cd",
        "/home/test/repo with spaces",
        "--exec",
        "node",
        "dist/sidebar-sync.js",
        "export",
        "--stdout",
      ],
      expect.objectContaining({
        maxBuffer: 16 * 1024 * 1024,
        timeout: 120_000,
        windowsHide: true,
      })
    );
    run.mockResolvedValue({
      stdout: JSON.stringify({ ...snapshot, schemaVersion: 1 }),
    });
    await expect(
      readWslSidebarSnapshot(
        { distribution: "Test", repository: "/repo", skipEmptyProjects: false },
        run
      )
    ).rejects.toThrow("schemaVersion");
    run.mockRejectedValue(new Error("Export timed out"));
    await expect(
      readWslSidebarSnapshot(
        { distribution: "Test", repository: "/repo", skipEmptyProjects: false },
        run
      )
    ).rejects.toThrow("timed out");
  });

  test("atomically replaces a snapshot and refuses invalid or accidental overwrites", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-sidebar-export-"));
    const file = path.join(directory, "snapshot.json");
    try {
      await saveSidebarSnapshot(snapshot, file, false);
      const original = await readFile(file, "utf-8");
      await expect(
        saveSidebarSnapshot({ ...snapshot, threads: [] }, file, false)
      ).rejects.toThrow("EEXIST");
      await expect(readFile(file, "utf-8")).resolves.toBe(original);
      await saveSidebarSnapshot(
        filterSidebarProjects(snapshot, true),
        file,
        true
      );
      expect(
        sidebarSnapshotSchema.parse(JSON.parse(await readFile(file, "utf-8")))
          .projects
      ).toHaveLength(1);
      await expect(readdir(directory)).resolves.toStrictEqual([
        "snapshot.json",
      ]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("rejects missing or conflicting export destinations before contacting a daemon", async () => {
    await expect(
      runSidebarSync(["node", "sidebar-sync", "export"])
    ).rejects.toThrow("exactly one");
    await expect(
      runSidebarSync([
        "node",
        "sidebar-sync",
        "export",
        "--stdout",
        "--output",
        "unused.json",
      ])
    ).rejects.toThrow("exactly one");
  });
});
