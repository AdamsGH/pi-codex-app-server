import { createHash } from "node:crypto";
import { cp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const statePath = path.join(root, ".cache/runtime-state.json");
const load = async () => JSON.parse(await readFile(statePath, "utf-8"));
const save = (state) => writeFile(statePath, JSON.stringify(state));
const githubPrefix = "repos/AdamsGH/pi-codex-app-server/";

const executeApi = async (state, args, options) => {
  const endpoint = args.find(
    (arg) => arg === "user" || arg.startsWith(githubPrefix)
  );
  const method = args.includes("--method")
    ? args[args.indexOf("--method") + 1]
    : "GET";
  switch (endpoint) {
    case "user": {
      return JSON.stringify({ login: "AdamsGH", type: "User" });
    }
    case `${githubPrefix}actions/runs/123`: {
      return JSON.stringify({
        conclusion: "success",
        head_branch: "main",
        head_sha: state.artifact.sourceCommit,
        path: ".github/workflows/prepare-release.yml",
        status: "completed",
      });
    }
    case `${githubPrefix}releases?per_page=100`: {
      return JSON.stringify([
        [
          { body: null, tag_name: "v0.0.0" },
          ...(state.release ? [state.release] : []),
        ],
      ]);
    }
    case `${githubPrefix}git/matching-refs/tags/${state.artifact.tag}`: {
      return JSON.stringify(
        state.tag ? [{ ref: `refs/tags/${state.artifact.tag}` }] : []
      );
    }
    case `${githubPrefix}git/refs`: {
      const body = JSON.parse(await options.stdin.text());
      if (method !== "POST" || body.sha !== state.artifact.sourceCommit) {
        throw new Error("Unexpected tag mutation");
      }
      state.tag = true;
      return "{}";
    }
    case `${githubPrefix}commits/${state.artifact.tag}`: {
      return JSON.stringify({ sha: state.artifact.sourceCommit });
    }
    case `${githubPrefix}releases/123`: {
      if (method === "PATCH") {
        const body = JSON.parse(await options.stdin.text());
        if (body.draft !== false || body.make_latest !== "true") {
          throw new Error("Unexpected release mutation");
        }
        state.release.draft = false;
        state.releasePublications += 1;
      }
      return JSON.stringify(state.release);
    }
    case `${githubPrefix}releases/latest`: {
      return JSON.stringify(state.release);
    }
    default: {
      throw new Error("Unexpected synthetic GitHub request");
    }
  }
};

const execute = async (argv, options) => {
  const state = await load();
  let output = "";
  if (argv.includes("package:check")) {
    state.packageChecks += 1;
  } else if (argv.includes("whoami")) {
    output = "adamsgh";
  } else if (argv.includes("publish")) {
    const receipt = JSON.parse(
      await readFile(
        path.join(
          root,
          "docs/reports/releases",
          state.artifact.version,
          "npm-attempt.json"
        ),
        "utf-8"
      )
    );
    if (
      receipt.artifact.sha256 !== state.artifact.sha256 ||
      state.npmPublishes
    ) {
      throw new Error("Missing receipt or replayed npm mutation");
    }
    state.npmPublishes += 1;
  } else if (argv[0] === "gh") {
    const args = argv.slice(1);
    if (args[0] === "run" && args[1] === "download") {
      await cp(
        path.join(root, ".cache/candidate"),
        args[args.indexOf("--dir") + 1],
        { recursive: true }
      );
    } else if (args[0] === "release" && args[1] === "create") {
      state.release = {
        assets: [],
        author: { login: "AdamsGH" },
        body: await readFile(args[args.indexOf("--notes-file") + 1], "utf-8"),
        draft: true,
        html_url:
          "https://github.com/AdamsGH/pi-codex-app-server/releases/tag/v0.2.2",
        id: 123,
        tag_name: state.artifact.tag,
      };
    } else if (args[0] === "release" && args[1] === "upload") {
      const files = args.slice(args.indexOf("--repo") + 2);
      const assets = await Promise.all(
        files.map(async (file) => ({
          digest: `sha256:${createHash("sha256")
            .update(await readFile(file))
            .digest("hex")}`,
          name: path.basename(file),
          uploader: { login: "AdamsGH" },
        }))
      );
      state.release.assets.push(...assets);
      state.assetUploads += assets.length;
    } else if (args[0] === "api") {
      output = await executeApi(state, args, options);
    } else {
      throw new Error("Unexpected synthetic gh command");
    }
  } else {
    throw new Error(
      "Unexpected process; the release fixture never executes external commands"
    );
  }
  await save(state);
  return output;
};

const which = Bun.which.bind(Bun);
Bun.which = (command) =>
  command === "gh" || command === "npm" ? command : which(command);
Bun.spawn = (argv, options) => {
  const result = execute(argv, options);
  return {
    exited: (async () => {
      await result;
      return 0;
    })(),
    stdout: new ReadableStream({
      async start(controller) {
        try {
          controller.enqueue(new TextEncoder().encode(await result));
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    }),
  };
};

globalThis.fetch = async (input) => {
  const state = await load();
  const bytes = Buffer.from(state.archive);
  let response;
  if (String(input).endsWith("?write=true")) {
    const visible = state.npmPublishes > 0 && state.metadataReads > 0;
    if (state.npmPublishes > 0) {
      state.metadataReads += 1;
    }
    response = Response.json({
      "dist-tags": { latest: visible ? state.artifact.version : "0.2.1" },
      versions: visible
        ? {
            [state.artifact.version]: {
              _npmUser: { name: "adamsgh" },
              dist: {
                integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
                tarball: "https://registry.npmjs.org/archive.tgz",
              },
              name: state.artifact.package,
              version: state.artifact.version,
            },
          }
        : {},
    });
  } else if (String(input) === "https://registry.npmjs.org/archive.tgz") {
    response =
      state.tarballReads === 0
        ? new Response(null, { status: 404 })
        : new Response(bytes);
    state.tarballReads += 1;
  } else {
    throw new Error(
      "Unexpected network request; this fixture never reaches the network"
    );
  }
  await save(state);
  return response;
};

const schedule = globalThis.setTimeout;
globalThis.setTimeout = (callback, timeout, ...args) =>
  schedule(callback, Math.min(timeout, 10), ...args);
