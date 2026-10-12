import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

export const snapshotFiles = async (root: string): Promise<string[]> => {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const file = path.join(root, entry.name);
      if (entry.isDirectory()) {
        return await snapshotFiles(file);
      }
      if (!entry.isFile()) {
        throw new Error(`Unsupported snapshot entry: ${file}`);
      }
      return [file];
    })
  );
  return files.flat().toSorted((left, right) => {
    const a = left.replaceAll(path.sep, "/");
    const b = right.replaceAll(path.sep, "/");
    if (a === b) {
      return 0;
    }
    return a < b ? -1 : 1;
  });
};

export const snapshotDigest = async (root: string): Promise<string> => {
  const digest = createHash("sha256");
  const files = await snapshotFiles(root);
  const contents = await Promise.all(files.map((file) => readFile(file)));
  for (const [index, file] of files.entries()) {
    const name = path.relative(root, file).replaceAll(path.sep, "/");
    const content = contents[index];
    if (!content) {
      throw new Error(`Snapshot file disappeared: ${file}`);
    }
    const bytes = Buffer.from(
      content.toString("utf-8").replaceAll("\r\n", "\n")
    );
    digest.update(`${Buffer.byteLength(name)}:${name}:${bytes.length}:`);
    digest.update(bytes);
  }
  return digest.digest("hex");
};

export const verifyProtocolSnapshot = async (vendor: string): Promise<void> => {
  const manifest = z
    .object({
      cliVersion: z.string(),
      commonSha256: z.string(),
      jsonSchemaSha256: z.string(),
      typescriptSha256: z.string(),
      upstream: z.object({ tag: z.string() }),
    })
    .parse(
      JSON.parse(
        await readFile(path.join(vendor, "protocol-snapshot.json"), "utf-8")
      )
    );
  const [typescript, schemas, common, bundle, generatedBundle] =
    await Promise.all([
      snapshotDigest(path.join(vendor, "typescript")),
      snapshotDigest(path.join(vendor, "json-schema")),
      readFile(path.join(vendor, "common.rs")),
      readFile(path.join(vendor, "codex_app_server_protocol.v2.schemas.json")),
      readFile(
        path.join(
          vendor,
          "json-schema/codex_app_server_protocol.v2.schemas.json"
        )
      ),
    ]);
  if (
    typescript !== manifest.typescriptSha256 ||
    schemas !== manifest.jsonSchemaSha256 ||
    createHash("sha256")
      .update(common.toString("utf-8").replaceAll("\r\n", "\n"))
      .digest("hex") !== manifest.commonSha256 ||
    !bundle.equals(generatedBundle) ||
    manifest.upstream.tag !== `rust-v${manifest.cliVersion}`
  ) {
    throw new Error(
      "Protocol snapshot is inconsistent. Run bun run protocol:sync before building."
    );
  }
};
