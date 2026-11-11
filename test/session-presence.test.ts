import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { readPiPresence } from "../src/pi/session-presence.js";

const record = (pid: number, threadId: string, touchedAt = Date.now()) =>
  JSON.stringify({ pid, threadId, touchedAt });

describe("Presence scan", () => {
  test("coalesces concurrent scans, removes crashed records and keeps live expired records", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "pi-presence-scan-"));
    const directory = path.join(home, "presence");
    await mkdir(directory);
    try {
      await Promise.all(
        Array.from({ length: 80 }, (_, index) =>
          writeFile(
            path.join(directory, `crashed-${index}.json`),
            record(1_073_741_823, "crashed")
          )
        )
      );
      await writeFile(
        path.join(directory, "active.json"),
        record(process.pid, "active")
      );
      await writeFile(
        path.join(directory, "expired.json"),
        record(process.pid, "expired", Date.now() - 60_000)
      );
      await writeFile(path.join(directory, "malformed.json"), "{");
      const pending = readPiPresence(home);
      expect(readPiPresence(path.join(home, "."))).toBe(pending);
      await expect(pending).resolves.toStrictEqual(new Set(["active"]));
      const remainingFiles = await readdir(directory);
      expect(remainingFiles.toSorted()).toStrictEqual([
        "active.json",
        "expired.json",
        "malformed.json",
      ]);
      await rm(path.join(directory, "active.json"));
      const next = readPiPresence(home);
      expect(next).not.toBe(pending);
      await expect(next).resolves.toStrictEqual(new Set());
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });

  test("a failed scan does not poison later scans or another home", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "pi-presence-retry-"));
    const directory = path.join(home, "presence");
    try {
      await writeFile(directory, "not a directory");
      await expect(readPiPresence(home)).rejects.toThrow(/ENOTDIR/u);
      await expect(
        readPiPresence(path.join(home, "other"))
      ).resolves.toStrictEqual(new Set());
      await rm(directory);
      await expect(readPiPresence(home)).resolves.toStrictEqual(new Set());
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });
});
