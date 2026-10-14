import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import { reconcileDesktopProjectPrefix } from "../src/desktop/project-order.js";
import type { DesktopInventory } from "../src/desktop/sidebar-reconciler.js";

const projects = ["codex:project:a", "chatgpt:project:b", "codex:project:c"];
const fixture = async () => {
  const home = await mkdtemp(path.join(tmpdir(), "project-prefix-"));
  const keys = [
    "codex:thread:local:wsl",
    ...projects,
    "codex:thread:local:win",
  ];
  const state: DesktopInventory = {
    sections: [{ itemKeys: keys, name: "Pi", sectionId: "pi" }],
  };
  const moveProject = vi.fn<(id: string) => Promise<void>>((id) => {
    const index = keys.findIndex((key) => key.endsWith(`:${id}`));
    const [key] = keys.splice(index, 1);
    if (!key) {
      return Promise.reject(new Error("Missing project"));
    }
    keys.unshift(key);
    return Promise.resolve();
  });
  return {
    home,
    keys,
    moveProject,
    options: {
      moveProject,
      planFile: path.join(home, "pending.json"),
      readInventory: () => Promise.resolve(state),
      sectionId: "pi",
    },
  };
};

describe("Desktop project prefix", () => {
  test("keeps projects above chats while preserving both relative orders and avoiding repeated writes", async () => {
    const f = await fixture();
    try {
      await expect(
        reconcileDesktopProjectPrefix(f.options)
      ).resolves.toBeTruthy();
      expect(f.keys).toStrictEqual([
        ...projects,
        "codex:thread:local:wsl",
        "codex:thread:local:win",
      ]);
      await expect(
        reconcileDesktopProjectPrefix(f.options)
      ).resolves.toBeFalsy();
      expect(f.moveProject.mock.calls).toStrictEqual([["c"], ["b"], ["a"]]);
      await expect(readdir(f.home)).resolves.toStrictEqual([]);
    } finally {
      await rm(f.home, { force: true, recursive: true });
    }
  });

  test.each(["c", "b"])(
    "resumes a persisted original order after uncertain placement of %s",
    async (failId) => {
      const f = await fixture();
      try {
        const moveProject = async (id: string) => {
          await f.moveProject(id);
          if (id === failId) {
            throw new Error("Uncertain write");
          }
        };
        await expect(
          reconcileDesktopProjectPrefix({ ...f.options, moveProject })
        ).rejects.toThrow("Uncertain write");
        expect(
          JSON.parse(await readFile(f.options.planFile, "utf-8"))
        ).toStrictEqual({ projects, sectionId: "pi" });
        await expect(
          reconcileDesktopProjectPrefix(f.options)
        ).resolves.toBeTruthy();
        expect(f.keys.slice(0, projects.length)).toStrictEqual(projects);
        expect(f.moveProject.mock.calls).toStrictEqual([["c"], ["b"], ["a"]]);
      } finally {
        await rm(f.home, { force: true, recursive: true });
      }
    }
  );

  test("requires native placement confirmation and retains the pending plan on failure", async () => {
    const f = await fixture();
    try {
      await expect(
        reconcileDesktopProjectPrefix({
          ...f.options,
          moveProject: () => Promise.resolve(),
        })
      ).rejects.toThrow("did not confirm project placement");
      expect(
        JSON.parse(await readFile(f.options.planFile, "utf-8"))
      ).toStrictEqual({ projects, sectionId: "pi" });
      expect(f.keys[0]).toBe("codex:thread:local:wsl");
    } finally {
      await rm(f.home, { force: true, recursive: true });
    }
  });
});
