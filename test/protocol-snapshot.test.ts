import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  snapshotDigest,
  verifyProtocolSnapshot,
} from "../scripts/protocol-snapshot.js";
import { CODEX_APP_SERVER_COMPATIBILITY_VERSION } from "../src/codex-app-server-identity.js";
import {
  CodexClientMethodNames,
  CodexServerMethodNames,
} from "../src/protocol/generated/codex-methods.js";
import snapshot from "../vendor/openai-codex-app-server-protocol/protocol-snapshot.json" with { type: "json" };

const vendor = path.resolve(
  import.meta.dirname,
  "../vendor/openai-codex-app-server-protocol"
);

describe("Protocol snapshot", () => {
  test("advertises the version of the complete vendored snapshot", async () => {
    await expect(verifyProtocolSnapshot(vendor)).resolves.toBeUndefined();
    expect(CODEX_APP_SERVER_COMPATIBILITY_VERSION).toBe(snapshot.cliVersion);
    await expect(snapshotDigest(path.join(vendor, "typescript"))).resolves.toBe(
      snapshot.typescriptSha256
    );
    await expect(
      snapshotDigest(path.join(vendor, "json-schema"))
    ).resolves.toBe(snapshot.jsonSchemaSha256);
    await expect(
      readFile(path.join(vendor, "codex_app_server_protocol.v2.schemas.json"))
    ).resolves.toStrictEqual(
      await readFile(
        path.join(
          vendor,
          "json-schema/codex_app_server_protocol.v2.schemas.json"
        )
      )
    );
  });

  test("maps every request in the vendored protocol in both directions", async () => {
    await Promise.all(
      (
        [
          ["ClientRequest", CodexClientMethodNames],
          ["ServerRequest", CodexServerMethodNames],
        ] as const
      ).map(async ([name, methods]) => {
        const source = await readFile(
          path.join(vendor, "typescript", `${name}.ts`),
          "utf-8"
        );
        const generated = Array.from(
          source.matchAll(/"method":\s*"(?<method>[^"]+)"/gu),
          (match) => match.groups?.method
        ).toSorted();
        expect([...methods].toSorted()).toStrictEqual(generated);
      })
    );
  });
});
