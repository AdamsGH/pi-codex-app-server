import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import { PiProjectCatalog } from "../src/pi/project-catalog.js";
import { PiSessionRepository } from "../src/pi/session-repository.js";
import { PiThreadCatalog } from "../src/pi/thread-catalog.js";
import { PiThreadSections } from "../src/pi/thread-sections.js";
import { MetadataDatabase } from "../src/storage/metadata-database.js";

describe("Sidebar organization", () => {
  test("automatic Pi section ordering follows activity instead of stale positions", async () => {
    const database = new MetadataDatabase(":memory:");
    try {
      const repository = new PiSessionRepository(database);
      const sessions = [
        { id: "z-old", modified: new Date(10_000) },
        { id: "a-new", modified: new Date(40_000) },
      ].map(({ id, modified }) => ({
        allMessagesText: id,
        created: new Date(0),
        cwd: tmpdir(),
        firstMessage: id,
        id,
        messageCount: 1,
        modified,
        path: `${id}.jsonl`,
      }));
      vi.spyOn(repository, "list").mockResolvedValue(sessions);
      for (const session of sessions) {
        database.upsertThread({
          archived: false,
          projectId: null,
          sessionFile: session.path,
          threadId: session.id,
          updatedAt: session.modified.getTime(),
        });
      }
      const catalog = new PiThreadCatalog({
        database,
        sessionRepository: repository,
      });
      const page = await catalog.list({ sortKey: "section_position" });
      expect(page.data.map(({ id }) => id)).toStrictEqual(["a-new", "z-old"]);
    } finally {
      database.close();
    }
  });

  test("section moves persist, respect explicit unassignment, and order within the destination", () => {
    const database = new MetadataDatabase(":memory:");
    try {
      for (const threadId of ["a", "b", "c"]) {
        database.upsertThread({
          archived: false,
          projectId: null,
          sessionFile: `${threadId}.jsonl`,
          threadId,
          updatedAt: 0,
        });
      }
      const sections = new PiThreadSections(database);
      const [initial] = sections.list({}).data;
      expect(initial).toMatchObject({ name: "Pi" });
      if (!initial) {
        throw new Error("Default section missing");
      }

      const { section } = sections.create({ name: "Other" });
      sections.move({ sectionId: section.id, threadId: "a" });
      sections.move({
        beforeThreadId: "a",
        sectionId: section.id,
        threadId: "b",
      });
      const restored = new PiThreadSections(database);
      expect([restored.get("a"), restored.get("b")]).toMatchObject([
        { position: 1, section },
        { position: 0, section },
      ]);
      const enteredAt = restored.get("a").sectionEnteredAt;
      restored.move({
        beforeThreadId: "b",
        sectionId: section.id,
        threadId: "a",
      });
      expect(restored.get("a").sectionEnteredAt).toBe(enteredAt);
      expect(() =>
        restored.move({
          beforeThreadId: "c",
          sectionId: section.id,
          threadId: "a",
        })
      ).toThrow("destination section");
      restored.move({ sectionId: null, threadId: "a" });
      const unassigned = new PiThreadSections(database).get("a").section;
      restored.delete(section.id);
      expect([
        unassigned,
        restored.get("b").section,
        database.listThreads().length,
      ]).toStrictEqual([null, null, 3]);
    } finally {
      database.close();
    }
  });

  test("repository projects share a root, preserve assignments, and survive deletion without resurrection", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-project-catalog-"));
    const database = new MetadataDatabase(":memory:");
    try {
      const root = path.join(directory, "repo");
      await mkdir(path.join(root, ".git"), { recursive: true });
      const nested = path.join(root, "a", "b");
      await mkdir(nested, { recursive: true });
      const catalog = new PiProjectCatalog(database);
      const id = catalog.discover(nested);
      expect([
        catalog.discover(root),
        catalog.discover(directory),
        catalog.discover(path.join(directory, "gone")),
      ]).toStrictEqual([id, null, null]);
      if (!id) {
        throw new Error("Project missing");
      }
      expect(catalog.read(id).project.roots).toStrictEqual([{ path: root }]);
      database.upsertThread({
        archived: false,
        projectId: id,
        sessionFile: "a.jsonl",
        threadId: "a",
        updatedAt: 0,
      });
      catalog.assign("a", null);
      expect(new PiProjectCatalog(database).isAssigned("a")).toBeTruthy();
      catalog.delete(id);
      expect([
        catalog.discover(root),
        database.getThread("a")?.projectId,
      ]).toStrictEqual([null, null]);
      const params = {
        idempotencyKey: "manual",
        name: "Manual",
        roots: [{ path: directory }],
      };
      const first = catalog.import({ ...params, threads: ["a"] });
      expect([
        catalog.create(params),
        database.getThread("a")?.projectId,
      ]).toStrictEqual([first, first.project.id]);
    } finally {
      database.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("thread listing filters projects and sections independently", async () => {
    const database = new MetadataDatabase(":memory:");
    try {
      const repository = new PiSessionRepository(database);
      const { project } = repository.projects.create({
        idempotencyKey: "repo",
        name: "Repo",
        roots: [],
      });
      vi.spyOn(repository, "list").mockResolvedValue(
        ["a", "b"].map((id) => ({
          allMessagesText: id,
          created: new Date(0),
          cwd: tmpdir(),
          firstMessage: id,
          id,
          messageCount: 1,
          modified: new Date(0),
          path: `${id}.jsonl`,
        }))
      );
      for (const id of ["a", "b"]) {
        database.upsertThread({
          archived: false,
          projectId: id === "a" ? project.id : null,
          sessionFile: `${id}.jsonl`,
          threadId: id,
          updatedAt: 0,
        });
      }
      const catalog = new PiThreadCatalog({
        database,
        sessionRepository: repository,
      });
      const [defaultSection] = catalog.sections.list({}).data;
      if (!defaultSection) {
        throw new Error("Default section missing");
      }
      catalog.sections.move({ sectionId: defaultSection.id, threadId: "a" });
      catalog.sections.move({ sectionId: null, threadId: "b" });
      const assigned = await catalog.list({ projectId: project.id });
      const unassigned = await catalog.list({
        projectId: null,
        sectionId: null,
      });
      const { section } = catalog.sections.get("a");
      const inSection = await catalog.list({ sectionId: section?.id });
      expect(
        [assigned, unassigned, inSection].map(({ data }) =>
          data.map(({ id }) => id)
        )
      ).toStrictEqual([["a"], ["b"], ["a"]]);
    } finally {
      database.close();
    }
  });

  test("automatic Pi membership yields to a repository, while explicit section moves survive", () => {
    const database = new MetadataDatabase(":memory:");
    try {
      for (const threadId of ["a", "b"]) {
        database.upsertThread({
          archived: false,
          projectId: null,
          sessionFile: `${threadId}.jsonl`,
          threadId,
          updatedAt: 0,
        });
      }
      const sections = new PiThreadSections(database);
      const [section] = sections.list({}).data;
      if (!section) {
        throw new Error("Default section missing");
      }
      sections.move({ sectionId: section.id, threadId: "b" });
      const { project } = new PiProjectCatalog(database).create({
        idempotencyKey: "repo",
        name: "Repo",
        roots: [],
      });
      const thread = database.getThread("a");
      if (!thread) {
        throw new Error("Thread missing");
      }
      database.upsertThread({ ...thread, projectId: project.id });
      expect(sections.get("a").section).toBeNull();
      sections.move({ sectionId: section.id, threadId: "a" });
      expect(sections.get("a").section?.id).toBe(section.id);
      expect(sections.get("a").sectionEnteredAt).toStrictEqual(
        expect.any(Number)
      );
    } finally {
      database.close();
    }
  });
});
