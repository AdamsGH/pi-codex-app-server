import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  releaseArtifactSchema,
  releaseDigest,
  verifyReleaseArtifact,
} from "../scripts/release-artifact.js";

describe("Release artifact identity", () => {
  test("rejects paths and inconsistent version identities in an external manifest", () => {
    const valid = {
      filename: "pi-switch-pi-codex-app-server-0.2.0.tgz",
      package: "@pi-switch/pi-codex-app-server",
      sha256: "a".repeat(64),
      sourceCommit: "b".repeat(40),
      tag: "v0.2.0",
      version: "0.2.0",
    };
    expect(releaseArtifactSchema.safeParse(valid).success).toBeTruthy();
    expect(
      releaseArtifactSchema.safeParse({ ...valid, filename: "../other.tgz" })
        .success
    ).toBeFalsy();
    expect(
      releaseArtifactSchema.safeParse({ ...valid, tag: "v0.3.0" }).success
    ).toBeFalsy();
  });

  test("accepts the recorded bytes and commit, rejects a changed archive, commit and dirty source", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "pi-release-artifact-"));
    const root = path.join(home, "source");
    await mkdir(root);
    const git = (args: string[]): string =>
      execFileSync("git", args, {
        cwd: root,
        encoding: "utf-8",
        timeout: 15_000,
      }).trim();
    git(["init", "--quiet"]);
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "@pi-switch/pi-codex-app-server",
        version: "0.2.0",
      })
    );
    git(["add", "package.json"]);
    git([
      "-c",
      "user.name=Release Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Fixture",
    ]);
    const filename = "pi-switch-pi-codex-app-server-0.2.0.tgz";
    const archive = path.join(home, filename);
    const candidate = path.join(home, "release.json");
    const original = Buffer.from("synthetic archive bytes");
    const manifest = {
      filename,
      package: "@pi-switch/pi-codex-app-server",
      sha256: releaseDigest(original),
      sourceCommit: git(["rev-parse", "HEAD"]),
      tag: "v0.2.0",
      version: "0.2.0",
    };
    await writeFile(archive, original);
    await writeFile(candidate, JSON.stringify(manifest));
    try {
      await expect(
        verifyReleaseArtifact(candidate, archive, root)
      ).resolves.toBeUndefined();
      await writeFile(archive, "changed bytes");
      await expect(
        verifyReleaseArtifact(candidate, archive, root)
      ).rejects.toThrow("checksum mismatch");
      await writeFile(archive, original);
      await writeFile(
        candidate,
        JSON.stringify({ ...manifest, sourceCommit: "0".repeat(40) })
      );
      await expect(
        verifyReleaseArtifact(candidate, archive, root)
      ).rejects.toThrow("checked-out release source");
      await writeFile(candidate, JSON.stringify(manifest));
      await writeFile(path.join(root, "uncommitted.txt"), "dirty");
      await expect(
        verifyReleaseArtifact(candidate, archive, root)
      ).rejects.toThrow("checked-out release source");
      await expect(readFile(archive)).resolves.toStrictEqual(original);
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });
});
