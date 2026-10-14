import { describe, expect, it } from "vitest";

import { resolveDesktopEndpoint } from "../src/desktop/desktop-endpoint";

const endpoint = "\\\\.\\pipe\\codex-browser-use-test";
const unavailableDiscovery = (): Promise<string> =>
  Promise.reject(new Error("private endpoint and environment"));
const inventory = (endpoints: string[]) => ({
  discover: () => Promise.resolve(JSON.stringify(endpoints)),
  platform: "win32",
});

describe("desktop endpoint discovery", () => {
  it("passes the preferred pipe to verified discovery", async () => {
    const discover = (preferred: string | undefined): Promise<string> => {
      expect(preferred).toBe(endpoint);
      return Promise.resolve(JSON.stringify([endpoint]));
    };
    await expect(
      resolveDesktopEndpoint(endpoint, { discover, platform: "win32" })
    ).resolves.toBe(endpoint);
  });

  it("allows discovery to replace a dead preferred pipe", async () => {
    const replacement = `${endpoint}-replacement`;
    await expect(
      resolveDesktopEndpoint(endpoint, inventory([replacement]))
    ).resolves.toBe(replacement);
  });

  it("fails closed when discovery is ambiguous", async () => {
    await expect(
      resolveDesktopEndpoint(
        undefined,
        inventory([endpoint, `${endpoint}-other`])
      )
    ).rejects.toThrow("Multiple Codex");
  });

  it("fails closed when no installed desktop owner is found", async () => {
    await expect(
      resolveDesktopEndpoint(undefined, inventory([]))
    ).rejects.toThrow("No verified Codex");
  });

  it("rejects unexpected discovery endpoints", async () => {
    await expect(
      resolveDesktopEndpoint(undefined, inventory(["\\\\.\\pipe\\unrelated"]))
    ).rejects.toThrow("Invalid Codex");
  });

  it("does not disclose helper errors", async () => {
    await expect(
      resolveDesktopEndpoint(undefined, {
        discover: unavailableDiscovery,
        platform: "win32",
      })
    ).rejects.toThrow("Could not verify");
  });

  it("rejects unrelated preferred pipes before running discovery", async () => {
    await expect(
      resolveDesktopEndpoint("unrelated", inventory([endpoint]))
    ).rejects.toThrow("not a Codex");
  });

  it("requires an explicit endpoint outside Windows", async () => {
    const discovery = { ...inventory([]), platform: "linux" };
    await expect(resolveDesktopEndpoint(undefined, discovery)).rejects.toThrow(
      "explicit endpoint"
    );
    await expect(
      resolveDesktopEndpoint("/tmp/desktop.sock", discovery)
    ).resolves.toBe("/tmp/desktop.sock");
  });
});
