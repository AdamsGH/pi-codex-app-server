import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

export const releaseArtifactSchema = z
  .strictObject({
    filename: z.string().regex(/^[a-z0-9][a-z0-9.-]*\.tgz$/u),
    package: z.literal("@pi-switch/pi-codex-app-server"),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
    tag: z.string().regex(/^v\d+\.\d+\.\d+$/u),
    version: z.string().regex(/^\d+\.\d+\.\d+$/u),
  })
  .refine(
    (value) =>
      value.tag === `v${value.version}` &&
      value.filename === `pi-switch-pi-codex-app-server-${value.version}.tgz`,
    "Release identity is inconsistent"
  );

export const releaseDigest = (content: Uint8Array): string =>
  createHash("sha256").update(content).digest("hex");

export const releaseGit = (root: string, args: string[]): string =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf-8",
    timeout: 15_000,
  }).trim();

export const verifyReleaseArtifact = async (
  manifestPath: string,
  archive: string,
  root: string
): Promise<void> => {
  const manifest = releaseArtifactSchema.parse(
    JSON.parse(await readFile(manifestPath, "utf-8"))
  );
  const source = z
    .object({ name: z.string(), version: z.string() })
    .parse(
      JSON.parse(await readFile(path.join(root, "package.json"), "utf-8"))
    );
  if (
    releaseGit(root, ["status", "--porcelain"]) ||
    manifest.sourceCommit !== releaseGit(root, ["rev-parse", "HEAD"]) ||
    source.name !== manifest.package ||
    source.version !== manifest.version ||
    path.basename(archive) !== manifest.filename
  ) {
    throw new Error("Candidate does not match the checked-out release source");
  }
  if (releaseDigest(await readFile(archive)) !== manifest.sha256) {
    throw new Error("Release archive checksum mismatch");
  }
};
