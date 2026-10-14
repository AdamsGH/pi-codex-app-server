import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { publishProtocolSnapshot } from "../scripts/protocol-publication.js";
import type { ProtocolPublication } from "../scripts/protocol-publication.js";

const roots: string[] = [];
const fixture = async (): Promise<ProtocolPublication> => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-protocol-publication-"));
  roots.push(root);
  const transaction = path.join(root, "transaction");
  const input = {
    candidate: path.join(transaction, "candidate"),
    candidateMap: path.join(transaction, "methods.ts"),
    methodMap: path.join(root, "methods.ts"),
    transaction,
    vendor: path.join(root, "vendor"),
  };
  await Promise.all([
    mkdir(input.candidate, { recursive: true }),
    mkdir(input.vendor),
  ]);
  await Promise.all([
    writeFile(path.join(input.vendor, "obsolete.ts"), "old contract"),
    writeFile(path.join(input.candidate, "current.ts"), "new contract"),
    writeFile(input.methodMap, "old map"),
    writeFile(input.candidateMap, "new map"),
  ]);
  return input;
};

describe("protocol publication", () => {
  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
    );
  });

  it("replaces the complete snapshot and method map while retaining recovery files", async () => {
    const input = await fixture();
    await publishProtocolSnapshot(input);
    await expect(
      readFile(path.join(input.vendor, "current.ts"), "utf-8")
    ).resolves.toBe("new contract");
    await expect(
      readFile(path.join(input.vendor, "obsolete.ts"))
    ).rejects.toThrow("ENOENT");
    await expect(readFile(input.methodMap, "utf-8")).resolves.toBe("new map");
    await expect(
      readFile(
        path.join(input.transaction, "previous-vendor", "obsolete.ts"),
        "utf-8"
      )
    ).resolves.toBe("old contract");
  });

  it("restores the old snapshot and map after publication fails", async () => {
    const input = await fixture();
    const move: typeof rename = async (from, to) => {
      if (to === input.methodMap) {
        throw new Error("Injected map publication failure");
      }
      await rename(from, to);
    };
    await expect(publishProtocolSnapshot(input, move)).rejects.toThrow(
      "rolled back"
    );
    await expect(
      readFile(path.join(input.vendor, "obsolete.ts"), "utf-8")
    ).resolves.toBe("old contract");
    await expect(readFile(input.methodMap, "utf-8")).resolves.toBe("old map");
    await expect(
      readFile(path.join(input.transaction, "publication.json"), "utf-8")
    ).resolves.toContain("rolled-back");
  });

  it("rejects a candidate outside its owned transaction before changing live files", async () => {
    const input = await fixture();
    await expect(
      publishProtocolSnapshot({ ...input, candidate: input.vendor })
    ).rejects.toThrow("outside");
    await expect(readFile(input.methodMap, "utf-8")).resolves.toBe("old map");
  });
});
