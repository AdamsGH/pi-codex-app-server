/* eslint-disable no-await-in-loop -- Snapshot publication and stale-file removal must complete before writing its manifest. */
import { createHash } from "node:crypto";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { lock } from "proper-lockfile";
import { z } from "zod";

import { publishProtocolSnapshot } from "./protocol-publication.js";
import { snapshotDigest, verifyProtocolSnapshot } from "./protocol-snapshot.js";

const get = async (url: string): Promise<Response> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`Upstream request failed: ${response.status} ${url}`);
  }
  return response;
};

const root = path.resolve(import.meta.dir, "..");
const vendor = path.join(root, "vendor/openai-codex-app-server-protocol");
const executable = process.env.CODEX_PROTOCOL_CLI ?? "codex";
const cache = path.join(root, ".cache");
await mkdir(cache, { recursive: true });
const release = await lock(root, {
  lockfilePath: path.join(cache, "protocol-update.lock"),
  retries: 0,
});
try {
  const run = async (command: string[]): Promise<string> => {
    const child = Bun.spawn(command, {
      cwd: root,
      stderr: "inherit",
      stdout: "pipe",
      timeout: 60_000,
    });
    const output = await new Response(child.stdout).text();
    if ((await child.exited) !== 0) {
      throw new Error(`Protocol generation failed: ${command.join(" ")}`);
    }
    return output.trim();
  };
  const versionOutput = await run([executable, "--version"]);
  const version =
    /^codex-cli (?<version>\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)$/u.exec(
      versionOutput
    )?.groups?.version;
  if (!version) {
    throw new Error(`Unexpected Codex version: ${versionOutput}`);
  }
  const tag = `rust-v${version}`;
  const releaseResponse = await get(
    `https://api.github.com/repos/openai/codex/commits/${tag}`
  );
  const { sha: commit } = z
    .object({ sha: z.string().regex(/^[a-f0-9]{40}$/u) })
    .parse(await releaseResponse.json());
  const stage = path.join(
    root,
    ".cache",
    `protocol-${version}-${crypto.randomUUID()}`
  );
  const candidate = path.join(stage, "candidate");
  await mkdir(candidate, { recursive: true });
  for (const [command, directory] of [
    ["generate-ts", "typescript"],
    ["generate-json-schema", "json-schema"],
  ]) {
    if (!(command && directory)) {
      throw new Error("Invalid protocol generator configuration");
    }
    await run([
      executable,
      "app-server",
      command,
      "--experimental",
      "--out",
      path.join(candidate, directory),
    ]);
  }
  const commonResponse = await get(
    `https://raw.githubusercontent.com/openai/codex/${commit}/codex-rs/app-server-protocol/src/protocol/common.rs`
  );
  const commonSource = await commonResponse.text();
  await writeFile(path.join(candidate, "common.rs"), commonSource);
  const generateMap = async (source: string, output: string): Promise<void> => {
    await run([
      process.execPath,
      "run",
      path.join(root, "scripts/generate-codex-method-map.ts"),
      "--common",
      path.join(candidate, "common.rs"),
      "--protocol",
      path.join(source, "typescript"),
      "--schemas",
      path.join(source, "json-schema"),
      "--output",
      output,
      "--import-output",
      path.join(root, "src/protocol/generated/codex-methods.ts"),
      "--import-protocol",
      path.join(vendor, "typescript"),
      "--import-schemas",
      path.join(vendor, "json-schema"),
    ]);
  };
  await generateMap(candidate, path.join(stage, "methods.ts"));
  await copyFile(
    path.join(vendor, "UPSTREAM.md"),
    path.join(candidate, "UPSTREAM.md")
  );
  await copyFile(
    path.join(
      candidate,
      "json-schema/codex_app_server_protocol.v2.schemas.json"
    ),
    path.join(candidate, "codex_app_server_protocol.v2.schemas.json")
  );
  const manifest = {
    cliVersion: version,
    commonSha256: createHash("sha256")
      .update(commonSource.replaceAll("\r\n", "\n"))
      .digest("hex"),
    experimental: true,
    jsonSchemaSha256: await snapshotDigest(path.join(candidate, "json-schema")),
    typescriptSha256: await snapshotDigest(path.join(candidate, "typescript")),
    upstream: { commit, repository: "https://github.com/openai/codex", tag },
  };
  await writeFile(
    path.join(candidate, "protocol-snapshot.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  await verifyProtocolSnapshot(candidate);
  await publishProtocolSnapshot({
    candidate,
    candidateMap: path.join(stage, "methods.ts"),
    methodMap: path.join(root, "src/protocol/generated/codex-methods.ts"),
    transaction: stage,
    vendor,
  });
  process.stdout.write(
    `Updated protocol snapshot to Codex ${version} (${commit}). Run fix, typecheck, test, and build before deployment.\n`
  );
} finally {
  await release();
}
