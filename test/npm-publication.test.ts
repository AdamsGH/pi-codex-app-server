import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  inspectNpmRegistry,
  RegistryUnavailableError,
  submitNpmOnce,
  waitForNpmRegistry,
} from "../scripts/npm-publication.js";
import type { RegistryState } from "../scripts/npm-publication.js";
import {
  githubReleaseSchema,
  releaseArtifactSchema,
  releaseDigest,
  verifyGithubReleaseIdentity,
} from "../scripts/release-artifact.js";

const archive = Buffer.from("synthetic release archive");
const artifact = releaseArtifactSchema.parse({
  filename: "pi-switch-pi-codex-app-server-0.2.2.tgz",
  package: "@pi-switch/pi-codex-app-server",
  sha256: releaseDigest(archive),
  sourceCommit: "a".repeat(40),
  tag: "v0.2.2",
  version: "0.2.2",
});
const version = {
  _npmUser: { name: "adamsgh" },
  dist: {
    integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
    tarball:
      "https://registry.npmjs.org/@pi-switch/pi-codex-app-server/-/pi-codex-app-server-0.2.2.tgz",
  },
  name: artifact.package,
  version: artifact.version,
};
const catalog = () => ({
  "dist-tags": { latest: artifact.version },
  versions: { [artifact.version]: version },
});

describe("npm publication reconciliation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("records intent before publication and refuses to replay an uncertain upload", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "npm-receipt-"));
    const receipt = path.join(directory, "npm-attempt.json");
    const publish = vi.fn<() => Promise<void>>(async () => {
      const intent = JSON.parse(await readFile(receipt, "utf-8"));
      expect(intent.artifact.sha256).toBe(artifact.sha256);
      throw new Error("CLI connection lost after upload");
    });
    try {
      await expect(submitNpmOnce(receipt, artifact, publish)).rejects.toThrow(
        "connection lost"
      );
      await expect(
        submitNpmOnce(receipt, artifact, publish)
      ).resolves.toBeFalsy();
      expect(publish).toHaveBeenCalledOnce();
      await expect(
        submitNpmOnce(
          receipt,
          { ...artifact, sourceCommit: "b".repeat(40) },
          publish
        )
      ).rejects.toThrow("different candidate");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("waits through missing metadata, transient failures, and missing tarballs after accepted upload", async () => {
    vi.useFakeTimers();
    const inspect = vi
      .fn<() => Promise<RegistryState>>()
      .mockResolvedValueOnce({ state: "missing" })
      .mockRejectedValueOnce(new RegistryUnavailableError("503"))
      .mockResolvedValueOnce({ state: "pending" })
      .mockResolvedValueOnce({ archive, state: "verified" });
    const result = waitForNpmRegistry(inspect);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(result).resolves.toStrictEqual(archive);
    expect(inspect).toHaveBeenCalledTimes(4);
  });

  it("times out pending publication without treating absence as failure of the upload", async () => {
    vi.useFakeTimers();
    const inspect = vi
      .fn<() => Promise<RegistryState>>()
      .mockResolvedValue({ state: "missing" });
    await Promise.all([
      expect(waitForNpmRegistry(inspect)).rejects.toThrow(
        "keep the npm attempt receipt"
      ),
      vi.advanceTimersByTimeAsync(30 * 60_000),
    ]);
  });

  it("stops immediately on an integrity failure", async () => {
    const inspect = vi
      .fn<() => Promise<RegistryState>>()
      .mockRejectedValue(new Error("integrity mismatch"));
    await expect(waitForNpmRegistry(inspect)).rejects.toThrow(
      "integrity mismatch"
    );
    expect(inspect).toHaveBeenCalledOnce();
  });

  it("verifies registry identity and downloaded bytes rather than CLI success", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(catalog()))
      .mockResolvedValueOnce(new Response(archive));
    await expect(
      inspectNpmRegistry(artifact, archive, request)
    ).resolves.toStrictEqual({ archive, state: "verified" });
    expect(request).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("?write=true"),
      expect.objectContaining({ redirect: "error" })
    );
  });

  it.each([
    {
      label: "missing metadata",
      metadata: null,
      state: "missing",
      status: 404,
    },
    {
      label: "latest tag precedes metadata",
      metadata: { "dist-tags": { latest: artifact.version }, versions: {} },
      state: "pending",
      status: 200,
    },
  ])(
    "does not confuse $label with a verified release",
    async ({ metadata, state, status }) => {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json(metadata, { status }));
      await expect(
        inspectNpmRegistry(artifact, archive, request)
      ).resolves.toStrictEqual({ state });
    }
  );

  it("waits when a registered version's tarball is not yet visible", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(catalog()))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(
      inspectNpmRegistry(artifact, archive, request)
    ).resolves.toStrictEqual({ state: "pending" });
  });

  it("rejects malformed version metadata instead of treating it as an unpublished version", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json({
        ...catalog(),
        versions: { [artifact.version]: null },
      })
    );
    await expect(
      inspectNpmRegistry(artifact, archive, request)
    ).rejects.toThrow("expected object");
  });

  it.each([
    {
      label: "publisher",
      value: { ...version, _npmUser: { name: "unexpected" } },
    },
    {
      label: "integrity",
      value: {
        ...version,
        dist: { ...version.dist, integrity: "sha512-wrong" },
      },
    },
    {
      label: "tarball host",
      value: {
        ...version,
        dist: {
          ...version.dist,
          tarball: "https://example.invalid/archive.tgz",
        },
      },
    },
  ])("rejects a mismatched $label before downloading", async ({ value }) => {
    const metadata = { ...catalog(), versions: { [artifact.version]: value } };
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(metadata));
    await expect(
      inspectNpmRegistry(artifact, archive, request)
    ).rejects.toThrow(/adamsgh|differs from the candidate/u);
    expect(request).toHaveBeenCalledOnce();
  });

  it("rejects downloaded bytes that differ despite matching advertised integrity", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(catalog()))
      .mockResolvedValueOnce(new Response("different archive bytes"));
    await expect(
      inspectNpmRegistry(artifact, archive, request)
    ).rejects.toThrow("differs from the CI archive");
  });

  it("refuses to move latest backwards", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ ...catalog(), "dist-tags": { latest: "0.10.0" } })
      );
    await expect(
      inspectNpmRegistry(artifact, archive, request)
    ).rejects.toThrow("refusing a downgrade");
  });

  it("rejects unexpected GitHub authorship, app attribution, and release notes", () => {
    const release = githubReleaseSchema.parse({
      assets: [],
      author: { login: "AdamsGH" },
      body: "Reviewed notes",
      draft: true,
      html_url:
        "https://github.com/AdamsGH/pi-codex-app-server/releases/tag/v0.2.2",
      id: 123,
      tag_name: artifact.tag,
    });
    expect(() =>
      verifyGithubReleaseIdentity(release, artifact, "Reviewed notes")
    ).not.toThrow();
    expect(() =>
      verifyGithubReleaseIdentity(
        { ...release, author: { login: "unexpected" } },
        artifact,
        "Reviewed notes"
      )
    ).toThrow("GitHub release author");
    expect(() =>
      verifyGithubReleaseIdentity(
        { ...release, performed_via_github_app: { id: 1 } },
        artifact,
        "Reviewed notes"
      )
    ).toThrow("GitHub release author");
    expect(() =>
      verifyGithubReleaseIdentity(release, artifact, "Different notes")
    ).toThrow("GitHub release author");
  });
});
