import type { ResolveHook, ResolveHookContext } from "node:module";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { initialize, resolve } from "../src/runtime/pi-module-hooks.js";

type NextResolve = Parameters<ResolveHook>[2];
const context: ResolveHookContext = {
  conditions: ["node", "import"],
  importAttributes: {},
  parentURL: "file:///extension/dist/cli.js",
};
const hostParentUrl =
  "file:///host/node_modules/@earendil-works/pi-coding-agent/package.json";
const missing = Object.assign(new Error("Package not found"), {
  code: "ERR_MODULE_NOT_FOUND",
});

describe("daemon Pi module resolution", () => {
  beforeEach(() => {
    initialize(hostParentUrl);
  });

  it("keeps the standalone runtime when installed", async () => {
    const result = { url: "file:///extension/node_modules/pi/index.js" };
    const nextResolve = vi.fn<NextResolve>().mockResolvedValue(result);
    await expect(
      resolve("@earendil-works/pi-coding-agent", context, nextResolve)
    ).resolves.toBe(result);
    expect(nextResolve).toHaveBeenCalledExactlyOnceWith(
      "@earendil-works/pi-coding-agent",
      context
    );
  });

  it("resolves omitted Pi peers and their subpaths from the host", async () => {
    await Promise.all(
      ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai/oauth"].map(
        async (specifier) => {
          const result = { url: "file:///host/node_modules/pi/index.js" };
          const nextResolve = vi
            .fn<NextResolve>()
            .mockRejectedValueOnce(missing)
            .mockResolvedValueOnce(result);
          await expect(resolve(specifier, context, nextResolve)).resolves.toBe(
            result
          );
          expect(nextResolve).toHaveBeenLastCalledWith(specifier, {
            ...context,
            parentURL: hostParentUrl,
          });
        }
      )
    );
  });

  it("does not mask missing third-party packages or invalid Pi exports", async () => {
    await Promise.all(
      (
        [
          ["zod", missing],
          ["@earendil-works/pi-ai-extra", missing],
          [
            "@earendil-works/pi-ai/private",
            Object.assign(new Error("Private export"), {
              code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
            }),
          ],
        ] as const
      ).map(async ([specifier, error]) => {
        const nextResolve = vi.fn<NextResolve>().mockRejectedValue(error);
        await expect(resolve(specifier, context, nextResolve)).rejects.toBe(
          error
        );
        expect(nextResolve).toHaveBeenCalledOnce();
      })
    );
  });
});
