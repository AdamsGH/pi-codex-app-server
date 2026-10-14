import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { PiSessionPublication } from "../src/pi/session-publication.js";
import { PiSessionRepository } from "../src/pi/session-repository.js";
import { MetadataDatabase } from "../src/storage/metadata-database.js";

describe("Session catalog refresh", () => {
  test("rolls back the catalog batch when a thread violates a database constraint", () => {
    const database = new MetadataDatabase(":memory:");
    const metadata = {
      archived: false,
      projectId: null,
      sessionFile: "/synthetic.jsonl",
      threadId: "first",
      updatedAt: 0,
    };
    try {
      expect(() =>
        database.upsertThreads([
          metadata,
          { ...metadata, projectId: "missing-project", threadId: "second" },
        ])
      ).toThrow(/Failed query/u);
      expect(database.listThreads()).toStrictEqual([]);
    } finally {
      database.close();
    }
  });

  test("reuses unchanged summaries, coalesces scans and observes external writes, additions and deletion", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-catalog-cache-"));
    const directory = path.join(root, "sessions", "workspace");
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, "one.jsonl");
    const header = (id: string) =>
      `${JSON.stringify({
        cwd: root,
        id,
        timestamp: "2026-01-01T00:00:00Z",
        type: "session",
        version: 3,
      })}\n`;
    await writeFile(file, header("one"));
    await writeFile(
      path.join(directory, "invalid.jsonl"),
      'null\n{"type":"message"}\n{unfinished\n'
    );
    const database = new MetadataDatabase(":memory:");
    const repository = new PiSessionRepository(
      database,
      path.join(root, "sessions")
    );
    try {
      const pending = repository.list();
      expect(repository.list()).toBe(pending);
      const initial = await pending;
      const unchanged = await repository.list();
      expect(unchanged[0]).toBe(initial[0]);
      await appendFile(
        file,
        `${JSON.stringify({
          id: "name",
          name: "Renamed externally",
          parentId: null,
          timestamp: "2026-01-01T00:00:01Z",
          type: "session_info",
        })}\n`
      );
      const original = await readFile(file, "utf-8");
      const renamed = await repository.list();
      expect(renamed[0]).not.toBe(initial[0]);
      await expect(readFile(file, "utf-8")).resolves.toBe(original);
      await writeFile(path.join(directory, "two.jsonl"), header("two"));
      const added = await repository.list();
      await rm(file);
      const deleted = await repository.list();
      expect({
        added: added.map((session) => session.id).toSorted(),
        deleted: deleted.map((session) => session.id),
        initial: initial.map((session) => session.id),
        renamed: renamed[0]?.name,
      }).toStrictEqual({
        added: ["one", "two"],
        deleted: ["two"],
        initial: ["one"],
        renamed: "Renamed externally",
      });
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("treats a former working directory that is now a file as having no local policy", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-catalog-policy-"));
    const cwd = path.join(root, "former-directory");
    await writeFile(cwd, "now a file");
    const database = new MetadataDatabase(":memory:");
    try {
      const publication = new PiSessionPublication({
        agentDir: root,
        database,
        home: root,
      });
      await expect(publication.assertCanStart(cwd)).resolves.toBeUndefined();
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
