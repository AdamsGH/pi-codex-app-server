/* eslint-disable no-await-in-loop -- Snapshot publication and stale-file removal must complete before writing its manifest. */
import { createHash } from "node:crypto";
import { copyFile, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { snapshotDigest, snapshotFiles } from "./protocol-snapshot.js";

const root = path.resolve(import.meta.dir, "..");
const vendor = path.join(root, "vendor/openai-codex-app-server-protocol");
const executable = process.env.CODEX_PROTOCOL_CLI ?? "codex";
const run = async (command: string[]): Promise<string> => {
  const child = Bun.spawn(command, {
    cwd: root,
    stderr: "inherit",
    stdout: "pipe",
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
const get = async (url: string): Promise<Response> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Upstream request failed: ${response.status} ${url}`);
  }
  return response;
};
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
await mkdir(stage, { recursive: true });
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
    path.join(stage, directory),
  ]);
}
const commonResponse = await get(
  `https://raw.githubusercontent.com/openai/codex/${commit}/codex-rs/app-server-protocol/src/protocol/common.rs`
);
const commonSource = await commonResponse.text();
await writeFile(path.join(stage, "common.rs"), commonSource);
const generateMap = async (source: string, output: string): Promise<void> => {
  await run([
    process.execPath,
    "run",
    path.join(root, "scripts/generate-codex-method-map.ts"),
    "--common",
    path.join(stage, "common.rs"),
    "--protocol",
    path.join(source, "typescript"),
    "--schemas",
    path.join(source, "json-schema"),
    "--output",
    output,
  ]);
};
await generateMap(stage, path.join(stage, "methods.ts"));
for (const directory of ["typescript", "json-schema"]) {
  const source = path.join(stage, directory);
  const target = path.join(vendor, directory);
  const generated = new Set<string>();
  for (const file of await snapshotFiles(source)) {
    const destination = path.join(target, path.relative(source, file));
    generated.add(destination);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(file, destination);
  }
  for (const file of await snapshotFiles(target)) {
    if (!generated.has(file)) {
      await unlink(file);
    }
  }
}
await copyFile(path.join(stage, "common.rs"), path.join(vendor, "common.rs"));
await copyFile(
  path.join(vendor, "json-schema/codex_app_server_protocol.v2.schemas.json"),
  path.join(vendor, "codex_app_server_protocol.v2.schemas.json")
);
await generateMap(
  vendor,
  path.join(root, "src/protocol/generated/codex-methods.ts")
);
const manifest = {
  cliVersion: version,
  commonSha256: createHash("sha256")
    .update(commonSource.replaceAll("\r\n", "\n"))
    .digest("hex"),
  experimental: true,
  jsonSchemaSha256: await snapshotDigest(path.join(vendor, "json-schema")),
  typescriptSha256: await snapshotDigest(path.join(vendor, "typescript")),
  upstream: { commit, repository: "https://github.com/openai/codex", tag },
};
await writeFile(
  path.join(vendor, "protocol-snapshot.json.tmp"),
  `${JSON.stringify(manifest, null, 2)}\n`
);
await rename(
  path.join(vendor, "protocol-snapshot.json.tmp"),
  path.join(vendor, "protocol-snapshot.json")
);
process.stdout.write(
  `Updated protocol snapshot to Codex ${version} (${commit}). Run fix, typecheck, test, and build before deployment.\n`
);
