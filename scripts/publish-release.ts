import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { lock } from "proper-lockfile";
import { z } from "zod";

import {
  inspectNpmRegistry,
  submitNpmOnce,
  waitForNpmRegistry,
} from "./npm-publication.js";
import {
  githubReleaseSchema,
  releaseArtifactSchema,
  releaseDigest,
  releaseGit,
  verifyGithubReleaseIdentity,
  verifyReleaseArtifact,
} from "./release-artifact.js";

const repo = "AdamsGH/pi-codex-app-server";
const root = path.resolve(import.meta.dir, "..");
const runSchema = z.object({
  conclusion: z.literal("success"),
  head_branch: z.literal("main"),
  head_sha: z.string(),
  path: z.literal(".github/workflows/prepare-release.yml"),
  status: z.literal("completed"),
});

const run = async (
  command: "gh" | "npm" | "bun",
  args: string[],
  interactive = false,
  input?: string
): Promise<string> => {
  const executable = Bun.which(command);
  if (!executable) {
    throw new Error(`${command} is required on PATH`);
  }
  const argv =
    command === "npm"
      ? [
          Bun.which("node") ?? "node",
          process.platform === "win32"
            ? path.join(
                path.dirname(executable),
                "node_modules/npm/bin/npm-cli.js"
              )
            : await realpath(executable),
          ...args,
        ]
      : [command === "bun" ? process.execPath : executable, ...args];
  const child = Bun.spawn(argv, {
    cwd: root,
    stderr: "inherit",
    stdin: input === undefined ? "inherit" : new Blob([input]),
    stdout: interactive ? "inherit" : "pipe",
    timeout: interactive ? 15 * 60_000 : 60_000,
  });
  const [output, code] = await Promise.all([
    interactive ? Promise.resolve("") : new Response(child.stdout).text(),
    child.exited,
  ]);
  if (code !== 0) {
    throw new Error(
      `${command} exited with code ${code}; reconcile before retrying`
    );
  }
  return output.trim();
};

const gh = (args: string[], input?: string) => run("gh", args, false, input);
const api = (endpoint: string) => gh(["api", `repos/${repo}/${endpoint}`]);
const mutate = (endpoint: string, method: "POST" | "PATCH", body: string) =>
  gh(
    ["api", "--method", method, `repos/${repo}/${endpoint}`, "--input", "-"],
    body
  );

const exists = async (file: string): Promise<boolean> => {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

const downloadCandidate = async (
  runId: string,
  directory: string
): Promise<string> => {
  process.stdout.write("Downloading the successful CI candidate.\n");
  const cache = path.join(root, ".cache");
  await mkdir(cache, { recursive: true });
  const download = await mkdtemp(path.join(cache, "release-download-"));
  const candidateDir = path.join(directory, "ci");
  try {
    await gh([
      "run",
      "download",
      runId,
      "--repo",
      repo,
      "--name",
      "release-candidate",
      "--dir",
      download,
    ]);
    const incoming = releaseArtifactSchema.parse(
      JSON.parse(await readFile(path.join(download, "release.json"), "utf-8"))
    );
    await verifyReleaseArtifact(
      path.join(download, "release.json"),
      path.join(download, incoming.filename),
      root
    );
    if (await exists(candidateDir)) {
      const existing = releaseArtifactSchema.parse(
        JSON.parse(
          await readFile(path.join(candidateDir, "release.json"), "utf-8")
        )
      );
      if (JSON.stringify(existing) !== JSON.stringify(incoming)) {
        throw new Error(
          "Local release records belong to a different CI archive"
        );
      }
    } else {
      await rename(download, candidateDir);
    }
  } finally {
    await rm(download, { force: true, recursive: true });
  }
  const artifact = releaseArtifactSchema.parse(
    JSON.parse(await readFile(path.join(candidateDir, "release.json"), "utf-8"))
  );
  const checksum = await readFile(
    path.join(candidateDir, "SHA256SUMS"),
    "utf-8"
  );
  if (checksum.trim() !== `${artifact.sha256}  ${artifact.filename}`) {
    throw new Error("SHA256SUMS differs from the release manifest");
  }
  return candidateDir;
};

const saveRegistryArchive = async (
  directory: string,
  artifact: z.infer<typeof releaseArtifactSchema>,
  bytes: Buffer
): Promise<string> => {
  const registryDir = path.join(directory, "registry");
  await mkdir(registryDir, { recursive: true });
  const archive = path.join(registryDir, artifact.filename);
  if (await exists(archive)) {
    if (releaseDigest(await readFile(archive)) !== artifact.sha256) {
      throw new Error("Existing registry archive differs from the candidate");
    }
  } else {
    await writeFile(archive, bytes, { flag: "wx" });
  }
  return archive;
};

const publishRelease = async (): Promise<void> => {
  const runId = z.string().regex(/^\d+$/u).parse(process.argv[2]);
  if (releaseGit(root, ["status", "--porcelain"])) {
    throw new Error("Publication requires a clean working tree");
  }
  const source = z
    .object({
      name: z.literal("@pi-switch/pi-codex-app-server"),
      version: z.string().regex(/^\d+\.\d+\.\d+$/u),
    })
    .parse(
      JSON.parse(await readFile(path.join(root, "package.json"), "utf-8"))
    );
  const directory = path.join(root, "docs/reports/releases", source.version);
  const notesPath = path.join(directory, "RELEASE.md");
  const notesFile = await readFile(notesPath, "utf-8");
  const notes = notesFile.trim();
  if (!notes) {
    throw new Error(`Review release notes in ${notesPath} before publishing`);
  }
  const unlock = await lock(notesPath, { retries: 0 });
  try {
    const actor = z
      .object({ login: z.literal("AdamsGH"), type: z.literal("User") })
      .parse(JSON.parse(await gh(["api", "user"])));
    if (
      (await run("npm", [
        "whoami",
        "--registry=https://registry.npmjs.org/",
      ])) !== "adamsgh"
    ) {
      throw new Error("npm publication requires the adamsgh account");
    }
    const ci = runSchema.parse(JSON.parse(await api(`actions/runs/${runId}`)));
    if (ci.head_sha !== releaseGit(root, ["rev-parse", "HEAD"])) {
      throw new Error("Successful CI run does not match HEAD");
    }
    const candidateDir = await downloadCandidate(runId, directory);
    const candidate = path.join(candidateDir, "release.json");
    const artifact = releaseArtifactSchema.parse(
      JSON.parse(await readFile(candidate, "utf-8"))
    );
    const archive = path.join(candidateDir, artifact.filename);
    await verifyReleaseArtifact(candidate, archive, root);
    await run("bun", ["run", "package:check", "--candidate", candidate], true);
    const bytes = await readFile(archive);
    const inspect = () => inspectNpmRegistry(artifact, bytes);
    const initial = await inspect();

    const findRelease = async () => {
      const releases = z
        .array(z.array(z.looseObject({ tag_name: z.string() })))
        .parse(
          JSON.parse(
            await gh([
              "api",
              `repos/${repo}/releases?per_page=100`,
              "--paginate",
              "--slurp",
            ])
          )
        )
        .flat()
        .filter((release) => release.tag_name === artifact.tag);
      if (releases.length > 1) {
        throw new Error("Multiple GitHub releases reference this tag");
      }
      const [entry] = releases;
      if (!entry) {
        return;
      }
      const release = githubReleaseSchema.parse(entry);
      verifyGithubReleaseIdentity(release, artifact, notes);
      return release;
    };
    let release = await findRelease();
    const refs = z
      .array(z.object({ ref: z.string() }))
      .parse(JSON.parse(await api(`git/matching-refs/tags/${artifact.tag}`)));
    if (!refs.some((ref) => ref.ref === `refs/tags/${artifact.tag}`)) {
      await mutate(
        "git/refs",
        "POST",
        JSON.stringify({
          ref: `refs/tags/${artifact.tag}`,
          sha: artifact.sourceCommit,
        })
      );
    }
    const commit = z
      .object({ sha: z.string() })
      .parse(JSON.parse(await api(`commits/${artifact.tag}`)));
    if (commit.sha !== artifact.sourceCommit) {
      throw new Error("Release tag points to a different source commit");
    }
    if (!release) {
      await gh([
        "release",
        "create",
        artifact.tag,
        "--repo",
        repo,
        "--verify-tag",
        "--draft",
        "--target",
        artifact.sourceCommit,
        "--title",
        `Pi Codex App Server ${artifact.version}`,
        "--notes-file",
        notesPath,
      ]);
      release = await findRelease();
    }
    if (!release) {
      throw new Error(
        "GitHub draft was not found after creation; reconcile before retrying"
      );
    }
    const assetFiles = [artifact.filename, "release.json", "SHA256SUMS"];
    const digests = new Map(
      await Promise.all(
        assetFiles.map(
          async (file) =>
            [
              file,
              `sha256:${releaseDigest(await readFile(path.join(candidateDir, file)))}`,
            ] as const
        )
      )
    );
    const checkAssets = (current: z.infer<typeof githubReleaseSchema>) => {
      for (const asset of current.assets) {
        if (
          asset.uploader.login !== actor.login ||
          asset.digest !== digests.get(asset.name)
        ) {
          throw new Error(
            "GitHub asset uploader, name, or digest differs from the candidate"
          );
        }
      }
    };
    const checkCompleteAssets = (
      current: z.infer<typeof githubReleaseSchema>
    ) => {
      checkAssets(current);
      if (current.assets.length !== assetFiles.length) {
        throw new Error(
          "GitHub assets are incomplete; reconcile before retrying"
        );
      }
    };
    checkAssets(release);
    const { assets } = release;
    const missing = assetFiles.filter(
      (file) => !assets.some((asset) => asset.name === file)
    );
    if (missing.length) {
      if (!release.draft) {
        throw new Error(
          "Published release assets are incomplete; preserve the published version"
        );
      }
      await gh([
        "release",
        "upload",
        artifact.tag,
        "--repo",
        repo,
        ...missing.map((file) => path.join(candidateDir, file)),
      ]);
    }
    release = await findRelease();
    if (!release) {
      throw new Error(
        "GitHub assets are incomplete; reconcile before retrying"
      );
    }
    checkCompleteAssets(release);

    if (initial.state === "missing") {
      await submitNpmOnce(
        path.join(directory, "npm-attempt.json"),
        artifact,
        async () => {
          process.stdout.write(
            "Publishing the CI archive; complete npm authentication when prompted.\n"
          );
          try {
            await run(
              "npm",
              [
                "publish",
                archive,
                "--access=public",
                "--tag=latest",
                "--registry=https://registry.npmjs.org/",
                "--ignore-scripts",
                "--loglevel=warn",
                "--no-progress",
              ],
              true
            );
          } catch {
            process.stderr.write(
              "npm did not complete successfully. Reconciling the registry without replaying npm publish.\n"
            );
          }
        }
      );
    }
    process.stdout.write(
      "Verifying npm visibility, publisher, latest tag, and archive bytes. No publish retries.\n"
    );
    const registryBytes =
      initial.state === "verified"
        ? initial.archive
        : await waitForNpmRegistry(inspect);
    const registryArchive = await saveRegistryArchive(
      directory,
      artifact,
      registryBytes
    );
    await run(
      "bun",
      [
        "run",
        "package:check",
        "--archive",
        registryArchive,
        "--candidate",
        candidate,
      ],
      true
    );
    release = await findRelease();
    if (!release) {
      throw new Error("GitHub release disappeared before publication");
    }
    checkCompleteAssets(release);
    const taggedCommit = z
      .object({ sha: z.string() })
      .parse(JSON.parse(await api(`commits/${artifact.tag}`)));
    if (taggedCommit.sha !== artifact.sourceCommit) {
      throw new Error("Release tag changed during publication");
    }
    if (release.draft) {
      await mutate(
        `releases/${release.id}`,
        "PATCH",
        JSON.stringify({ draft: false, make_latest: "true" })
      );
    }
    const published = githubReleaseSchema.parse(
      JSON.parse(await api(`releases/${release.id}`))
    );
    verifyGithubReleaseIdentity(published, artifact, notes);
    checkCompleteAssets(published);
    const latest = githubReleaseSchema.parse(
      JSON.parse(await api("releases/latest"))
    );
    if (published.draft || latest.id !== published.id) {
      throw new Error("GitHub publication or latest status is not verified");
    }
    await writeFile(
      path.join(directory, "publication.json"),
      `${JSON.stringify(
        {
          artifact,
          githubAuthor: actor.login,
          githubUrl: published.html_url,
          npmPublisher: "adamsgh",
          runId,
          verifiedAt: new Date().toISOString(),
        },
        null,
        2
      )}\n`
    );
    process.stdout.write(
      `Published and verified ${artifact.package}@${artifact.version}\n${published.html_url}\nRecords: ${directory}\n`
    );
  } finally {
    await unlock();
  }
};

if (process.argv[2] === "--help") {
  process.stdout.write(
    "Usage: just release-publish <successful-prepare-release-run-id>\nReview docs/reports/releases/<version>/RELEASE.md first. Rerun the same command to reconcile interrupted publication.\n"
  );
} else {
  await publishRelease();
}
