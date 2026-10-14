import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { z } from "zod";

const packageManifestSchema = z.object({
  dependencies: z.record(z.string(), z.string()),
  devDependencies: z.record(z.string(), z.string()),
  peerDependencies: z.record(z.string(), z.string()).default({}),
  pi: z.object({ extensions: z.array(z.string()) }),
});

describe("package manifest", () => {
  it("uses supported host-provided Pi packages and a consistent development SDK", async () => {
    const manifestContents = await readFile(
      new URL("../package.json", import.meta.url),
      "utf-8"
    );
    const manifest = packageManifestSchema.parse(JSON.parse(manifestContents));

    for (const name of [
      "@earendil-works/pi-ai",
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-tui",
    ]) {
      expect(manifest.dependencies).not.toHaveProperty(name);
      expect(manifest.peerDependencies[name]).toBe("~1.2.0");
      expect(manifest.devDependencies[name]).toBe("1.2.0");
    }
    expect(manifest.pi.extensions).toStrictEqual(["./src/extension/index.ts"]);
  });
});
