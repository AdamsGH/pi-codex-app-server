import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";

import { selectForkEntries } from "../src/pi/fork-entries.js";
import { PiSessionRepository } from "../src/pi/session-repository.js";
import { MetadataDatabase } from "../src/storage/metadata-database.js";

describe("Session forks", () => {
  test("forks only the selected branch without changing the source or losing entry identities", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-fork-"));
    const database = new MetadataDatabase(":memory:");
    try {
      const file = path.join(directory, "source.jsonl");
      const records = [
        {
          cwd: directory,
          id: "source",
          timestamp: "2026-01-01T00:00:00Z",
          type: "session",
          version: 3,
        },
        ...["user", "custom", "user", "custom"].map((role, index) => ({
          id: `entry-${index}`,
          message: {
            content: "Hello",
            customType: "fixture",
            display: true,
            role,
            timestamp: Date.parse("2026-01-01T00:00:00Z") + index * 1000,
          },
          parentId: index === 0 ? null : `entry-${index - 1}`,
          timestamp: `2026-01-01T00:00:0${index}Z`,
          type: "message",
        })),
      ];
      const content = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
      await writeFile(file, content);
      const source = SessionManager.open(file);
      const repository = new PiSessionRepository(database);
      const selected = source.getBranch().slice(0, 2);
      const id = await repository.fork(source, selected, directory, directory);
      const fork = await repository.read(id);
      expect(id).not.toBe("source");
      expect(fork?.manager.getBranch()).toStrictEqual(selected);
      expect(fork?.manager.getHeader()?.parentSession).toBe(file);
      expect(fork?.info.modified.getTime()).toBeGreaterThan(
        Date.parse("2026-01-01T00:00:00Z")
      );
      await expect(readFile(file, "utf-8")).resolves.toBe(content);
    } finally {
      database.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("rejects conflicting or nonexistent turn boundaries", () => {
    const source = SessionManager.inMemory();
    expect(() => selectForkEntries(source, "missing")).toThrow("unknown turn");
    expect(() => selectForkEntries(source, "first", "second")).toThrow(
      "Cannot combine"
    );
  });
});
