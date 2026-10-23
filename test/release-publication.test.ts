import { execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { releaseDigest } from "../scripts/release-artifact.js";

describe("release publisher acceptance", () => {
  it("completes a delayed npm publication in one invocation and safely reconciles a rerun", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "release-publisher-"));
    const project = process.cwd();
    const git = (args: string[]) =>
      execFileSync("git", args, {
        cwd: root,
        encoding: "utf-8",
        timeout: 15_000,
      }).trim();
    try {
      await mkdir(path.join(root, "scripts"));
      await mkdir(path.join(root, ".cache/candidate"), { recursive: true });
      await Promise.all(
        ["publish-release.ts", "release-artifact.ts", "npm-publication.ts"].map(
          (file) =>
            cp(
              path.join(project, "scripts", file),
              path.join(root, "scripts", file)
            )
        )
      );
      await cp(
        path.join(project, "test/fixtures/release-runtime.mjs"),
        path.join(root, ".cache/runtime.mjs")
      );
      await symlink(
        path.join(project, "node_modules"),
        path.join(root, "node_modules"),
        process.platform === "win32" ? "junction" : "dir"
      );
      await writeFile(
        path.join(root, ".gitignore"),
        ".cache/\ndocs/reports/\nnode_modules/\n"
      );
      await writeFile(
        path.join(root, "package.json"),
        JSON.stringify({
          name: "@pi-switch/pi-codex-app-server",
          type: "module",
          version: "0.2.2",
        })
      );
      git(["init", "--quiet"]);
      git(["add", "."]);
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
      const archive = "synthetic package bytes";
      const artifact = {
        filename: "pi-switch-pi-codex-app-server-0.2.2.tgz",
        package: "@pi-switch/pi-codex-app-server",
        sha256: releaseDigest(Buffer.from(archive)),
        sourceCommit: git(["rev-parse", "HEAD"]),
        tag: "v0.2.2",
        version: "0.2.2",
      };
      const candidate = path.join(root, ".cache/candidate");
      await writeFile(path.join(candidate, artifact.filename), archive);
      await writeFile(
        path.join(candidate, "release.json"),
        JSON.stringify(artifact)
      );
      await writeFile(
        path.join(candidate, "SHA256SUMS"),
        `${artifact.sha256}  ${artifact.filename}\n`
      );
      const directory = path.join(root, "docs/reports/releases/0.2.2");
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, "RELEASE.md"),
        "Reviewed synthetic release notes\n"
      );
      const statePath = path.join(root, ".cache/runtime-state.json");
      await writeFile(
        statePath,
        JSON.stringify({
          archive,
          artifact,
          assetUploads: 0,
          metadataReads: 0,
          npmPublishes: 0,
          packageChecks: 0,
          release: null,
          releasePublications: 0,
          tag: false,
          tarballReads: 0,
        })
      );
      const invoke = () =>
        execFileSync(
          "bun",
          [
            "--preload",
            path.join(root, ".cache/runtime.mjs"),
            path.join(root, "scripts/publish-release.ts"),
            "123",
          ],
          { cwd: root, encoding: "utf-8", timeout: 30_000 }
        );
      expect(invoke()).toContain(
        "Published and verified @pi-switch/pi-codex-app-server@0.2.2"
      );
      expect(invoke()).toContain(
        "Published and verified @pi-switch/pi-codex-app-server@0.2.2"
      );
      expect(JSON.parse(await readFile(statePath, "utf-8"))).toMatchObject({
        assetUploads: 3,
        npmPublishes: 1,
        packageChecks: 4,
        release: { draft: false },
        releasePublications: 1,
      });
      expect(
        JSON.parse(
          await readFile(path.join(directory, "publication.json"), "utf-8")
        )
      ).toMatchObject({
        artifact,
        githubAuthor: "AdamsGH",
        npmPublisher: "adamsgh",
        runId: "123",
      });
      await expect(
        readFile(path.join(directory, "registry", artifact.filename), "utf-8")
      ).resolves.toBe(archive);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 60_000);
});
