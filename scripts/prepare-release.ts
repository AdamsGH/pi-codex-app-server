import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  releaseArtifactSchema,
  releaseDigest,
  releaseGit,
  verifyReleaseArtifact,
} from "./release-artifact.js";

const root = path.resolve(import.meta.dir, "..");
if (releaseGit(root, ["status", "--porcelain"])) {
  throw new Error("Release preparation requires a clean working tree");
}
const sourceCommit = releaseGit(root, ["rev-parse", "HEAD"]);
const source = z
  .object({
    name: z.literal("@pi-switch/pi-codex-app-server"),
    version: z.string().regex(/^\d+\.\d+\.\d+$/u),
  })
  .parse(JSON.parse(await readFile(path.join(root, "package.json"), "utf-8")));
const output = path.join(root, "out", "release");
const filename = `pi-switch-pi-codex-app-server-${source.version}.tgz`;
const archive = path.join(output, filename);
const candidate = path.join(output, "release.json");
let existing = false;
try {
  await access(candidate);
  existing = true;
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
    throw error;
  }
}
if (existing) {
  await verifyReleaseArtifact(candidate, archive, root);
}
const args = existing
  ? ["--archive", archive, "--candidate", candidate]
  : ["--output", output];
const child = Bun.spawn(
  [
    process.execPath,
    "run",
    path.join(root, "scripts", "check-package.ts"),
    ...args,
  ],
  { cwd: root, stderr: "inherit", stdout: "inherit", timeout: 600_000 }
);
if ((await child.exited) !== 0) {
  throw new Error("Release package verification failed");
}
if (
  sourceCommit !== releaseGit(root, ["rev-parse", "HEAD"]) ||
  releaseGit(root, ["status", "--porcelain"])
) {
  throw new Error("Release source changed during preparation");
}
const manifest = releaseArtifactSchema.parse({
  filename,
  package: source.name,
  sha256: releaseDigest(await readFile(archive)),
  sourceCommit,
  tag: `v${source.version}`,
  version: source.version,
});
if (!existing) {
  await writeFile(candidate, `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx",
  });
  await writeFile(
    path.join(output, "SHA256SUMS"),
    `${manifest.sha256}  ${filename}\n`,
    { flag: "wx" }
  );
}
process.stdout.write(`${JSON.stringify(manifest)}\n`);
