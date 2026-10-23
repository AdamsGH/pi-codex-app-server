import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import { delay } from "es-toolkit";
import { z } from "zod";

import { releaseArtifactSchema, releaseDigest } from "./release-artifact.js";

type ReleaseArtifact = z.infer<typeof releaseArtifactSchema>;
export type RegistryState =
  | { readonly state: "missing" | "pending" }
  | { readonly state: "verified"; readonly archive: Buffer };

const catalogSchema = z.object({
  "dist-tags": z.object({ latest: z.string().regex(/^\d+\.\d+\.\d+$/u) }),
  versions: z.record(z.string(), z.json()),
});
const versionSchema = z.object({
  _npmUser: z.object({ name: z.literal("adamsgh") }),
  dist: z.object({ integrity: z.string(), tarball: z.url() }),
  name: z.literal("@pi-switch/pi-codex-app-server"),
  version: z.string(),
});
const receiptSchema = z.object({
  artifact: releaseArtifactSchema,
  submittedAt: z.iso.datetime(),
});

export class RegistryUnavailableError extends Error {
  override name = "RegistryUnavailableError";
}

const compareVersions = (left: string, right: string): number => {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
};

export const inspectNpmRegistry = async (
  artifact: ReleaseArtifact,
  archive: Buffer,
  request: typeof fetch = fetch
): Promise<RegistryState> => {
  const get = async (url: string): Promise<Response> => {
    let response: Response;
    try {
      response = await request(url, {
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new RegistryUnavailableError("npm registry request failed");
    }
    if (response.status === 429 || response.status >= 500) {
      throw new RegistryUnavailableError(
        `npm registry returned ${response.status}`
      );
    }
    return response;
  };
  const response = await get(
    "https://registry.npmjs.org/@pi-switch%2fpi-codex-app-server?write=true"
  );
  if (response.status === 404) {
    return { state: "missing" };
  }
  if (!response.ok) {
    throw new Error(`npm registry returned ${response.status}`);
  }
  const catalog = catalogSchema.parse(await response.json());
  const { latest } = catalog["dist-tags"];
  if (compareVersions(latest, artifact.version) > 0) {
    throw new Error("A newer npm release is latest; refusing a downgrade");
  }
  const entry = catalog.versions[artifact.version];
  if (entry === undefined) {
    return { state: latest === artifact.version ? "pending" : "missing" };
  }
  const version = versionSchema.parse(entry);
  const url = new URL(version.dist.tarball);
  if (
    version.version !== artifact.version ||
    version.dist.integrity !==
      `sha512-${createHash("sha512").update(archive).digest("base64")}` ||
    url.origin !== "https://registry.npmjs.org" ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "npm version, integrity, or tarball URL differs from the candidate"
    );
  }
  const download = await get(url.href);
  if (download.status === 404) {
    return { state: "pending" };
  }
  if (!download.ok) {
    throw new Error(`npm tarball returned ${download.status}`);
  }
  const bytes = Buffer.from(await download.arrayBuffer());
  if (
    bytes.length !== archive.length ||
    releaseDigest(bytes) !== artifact.sha256
  ) {
    throw new Error("npm tarball differs from the CI archive");
  }
  return latest === artifact.version
    ? { archive: bytes, state: "verified" }
    : { state: "pending" };
};

export const submitNpmOnce = async (
  receiptPath: string,
  artifact: ReleaseArtifact,
  publish: () => Promise<void>
): Promise<boolean> => {
  try {
    // Persist intent before the external mutation, including when the CLI later times out.
    await writeFile(
      receiptPath,
      JSON.stringify({
        artifact,
        submittedAt: new Date().toISOString(),
      }),
      { flag: "wx" }
    );
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "EEXIST")
    ) {
      throw error;
    }
    const receipt = receiptSchema.parse(
      JSON.parse(await readFile(receiptPath, "utf-8"))
    );
    if (JSON.stringify(receipt.artifact) !== JSON.stringify(artifact)) {
      throw new Error("npm attempt receipt belongs to a different candidate", {
        cause: error,
      });
    }
    return false;
  }
  await publish();
  return true;
};

export const waitForNpmRegistry = async (
  inspect: () => Promise<RegistryState>
): Promise<Buffer> => {
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    try {
      // eslint-disable-next-line no-await-in-loop -- Reconcile sequentially until the submitted version becomes visible.
      const state = await inspect();
      if (state.state === "verified") {
        return state.archive;
      }
    } catch (error) {
      if (!(error instanceof RegistryUnavailableError)) {
        throw error;
      }
    }
    // eslint-disable-next-line no-await-in-loop -- Bound read retries without resubmitting the mutation.
    await delay(10_000);
  }
  throw new Error(
    "npm publication is not yet verified. Rerun this command to resume checks; keep the npm attempt receipt."
  );
};
