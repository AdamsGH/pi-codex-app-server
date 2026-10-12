import { describe, expect, test } from "vitest";

import {
  CODEX_APP_SERVER_COMPATIBILITY_VERSION,
  codexAppServerUserAgent,
} from "../src/codex-app-server-identity.js";
import { appServerLogger } from "../src/logging/app-server-logger.js";
import { JsonRpcConnection } from "../src/protocol/json-rpc-connection.js";
import {
  ProtocolValidationError,
  addJsonRpcVersion,
  parseClientNotification,
  parseClientRequest,
  parseCodexWireMessage,
  removeJsonRpcVersion,
  validateClientResponse,
} from "../src/protocol/validation.js";
import type { MessageTransport } from "../src/transports/message-transport.js";

const oneExperimentalRequest =
  async function* oneExperimentalRequest(): AsyncIterable<string> {
    yield '{"id":0,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1"},"capabilities":null}}';
    yield '{"id":11,"method":"collaborationMode/list","params":{}}';
  };

describe("JSON-RPC boundary", () => {
  test("keeps the connection alive after an invalid handler response", async () => {
    const sent: string[] = [];
    const requests = [
      {
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "test", version: "1" } },
      },
      { id: 2, method: "thread/loaded/list", params: { cursor: "invalid" } },
      { id: 3, method: "thread/loaded/list", params: {} },
    ];
    const connection = new JsonRpcConnection({
      clientId: "validation-test",
      logger: appServerLogger,
      transport: {
        close: () => {},
        read: async function* read() {
          for (const request of requests) {
            yield JSON.stringify(request);
          }
        },
        send: (message) => {
          sent.push(message);
          return Promise.resolve();
        },
      },
    });
    connection.registerRequest("initialize", () => ({
      codexHome: "/tmp",
      platformFamily: "unix",
      platformOs: "linux",
      userAgent: "test",
    }));
    connection.registerRequest("thread/loaded/list", (params) => {
      const response = { data: ["valid"], nextCursor: null };
      if (params.cursor === "invalid") {
        Object.defineProperty(response, "data", { value: [42] });
      }
      return response;
    });
    await connection.run();
    expect(sent.map(parseCodexWireMessage)).toMatchObject([
      { id: 1, result: {} },
      { error: { code: -32_603 }, id: 2 },
      { id: 3, result: { data: ["valid"] } },
    ]);
  });

  test("accepts the desktop post-initialize authentication request", () => {
    const request = {
      id: "desktop-auth:repro",
      method: "getAuthStatus",
      params: { includeToken: false, refreshToken: false },
    };
    expect(parseClientRequest(request)).toStrictEqual(request);
  });

  test("accepts empty or omitted parameters for parameterless desktop requests", () => {
    for (const params of [{}, undefined, null]) {
      expect(() =>
        parseClientRequest({ id: 1, method: "configRequirements/read", params })
      ).not.toThrow();
    }
    expect(() =>
      parseClientRequest({
        id: 1,
        method: "configRequirements/read",
        params: { unexpected: true },
      })
    ).toThrow(ProtocolValidationError);
  });

  test("reports only the selected method's invalid parameters", () => {
    expect(() =>
      parseClientRequest({ id: 1, method: "initialize", params: {} })
    ).toThrow(/initialize.*clientInfo/u);
    expect(() =>
      parseClientRequest({ id: 1, method: "initialize", params: {} })
    ).not.toThrow(/threadId/u);
  });

  test("parses Codex's headerless wire messages", () => {
    const request = parseCodexWireMessage(
      '{"id":7,"method":"initialize","params":{"clientInfo":{"name":"test","title":null,"version":"1"},"capabilities":null}}'
    );
    expect(parseClientRequest(request)).toStrictEqual({
      id: 7,
      method: "initialize",
      params: {
        capabilities: null,
        clientInfo: { name: "test", title: null, version: "1" },
      },
    });

    const notification = parseCodexWireMessage('{"method":"initialized"}');
    expect(parseClientNotification(notification)).toStrictEqual({
      method: "initialized",
    });
  });

  test("rejects invalid envelopes and method parameters", () => {
    expect(() => parseCodexWireMessage("{")).toThrow(/./u);
    expect(() => parseCodexWireMessage('{"method":7,"params":null}')).toThrow(
      ProtocolValidationError
    );

    const invalidInitialize = parseCodexWireMessage(
      '{"id":1,"method":"initialize","params":{}}'
    );
    expect(() => parseClientRequest(invalidInitialize)).toThrow(
      ProtocolValidationError
    );
  });

  test("adds the JSON-RPC version only for the internal library", () => {
    const wireMessage = parseCodexWireMessage(
      '{"id":"request-1","result":{"value":1}}'
    );
    const libraryMessage = addJsonRpcVersion(wireMessage);
    expect(libraryMessage).toStrictEqual({
      id: "request-1",
      jsonrpc: "2.0",
      result: { value: 1 },
    });
    expect(removeJsonRpcVersion(libraryMessage)).toStrictEqual(wireMessage);
  });

  test("validates method-specific responses with official schemas", () => {
    expect(() =>
      validateClientResponse("initialize", {
        codexHome: "/tmp/codex",
        platformFamily: "unix",
        platformOs: "linux",
        userAgent: codexAppServerUserAgent(),
      })
    ).not.toThrow();
    expect(() => validateClientResponse("initialize", {})).toThrow(
      ProtocolValidationError
    );
  });

  test("rejects unimplemented methods instead of returning generated fixtures", async () => {
    const sent: string[] = [];
    const transport: MessageTransport = {
      close: () => {},
      read: oneExperimentalRequest,
      send: (message) => {
        sent.push(message);
        return Promise.resolve();
      },
    };
    const connection = new JsonRpcConnection({
      clientId: "experimental-test",
      logger: appServerLogger,
      transport,
    });
    connection.registerCompatibilityFallbacks();
    connection.registerRequest("initialize", () => ({
      codexHome: "/tmp/codex",
      platformFamily: "unix",
      platformOs: "linux",
      userAgent: codexAppServerUserAgent(),
    }));

    await connection.run();

    expect(sent).toHaveLength(2);
    expect(parseCodexWireMessage(sent[1] ?? "")).toMatchObject({
      error: { code: -32_601 },
      id: 11,
    });
  });

  test("matches the official Codex user-agent format", () => {
    expect(
      codexAppServerUserAgent({
        architecture: "x64",
        environment: { TERM: "dumb" },
        platform: "win32",
        release: "10.0.26200",
      })
    ).toBe(
      `codex_cli_rs/${CODEX_APP_SERVER_COMPATIBILITY_VERSION} (Windows 10.0.26200; x86_64) dumb`
    );
  });

  test("enforces per-connection initialization and exact notification opt-outs", async () => {
    const sent: string[] = [];
    const requests = [
      '{"id":1,"method":"thread/loaded/list","params":{}}',
      JSON.stringify({
        id: 2,
        method: "initialize",
        params: {
          capabilities: {
            optOutNotificationMethods: ["thread/name/updated", "unknown"],
          },
          clientInfo: { name: "test", version: "1" },
        },
      }),
      '{"method":"initialized"}',
      '{"id":3,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1"}}}',
      '{"id":4,"method":"thread/loaded/list","params":{}}',
    ];
    const read = async function* read(): AsyncIterable<string> {
      yield* requests;
    };
    const connection = new JsonRpcConnection({
      clientId: "handshake-test",
      logger: appServerLogger,
      transport: {
        close: () => {},
        read,
        send: (message) => {
          sent.push(message);
          return Promise.resolve();
        },
      },
    });
    connection.registerCompatibilityFallbacks();
    connection.registerRequest("initialize", () => ({
      codexHome: "/tmp/codex",
      platformFamily: "unix",
      platformOs: "linux",
      userAgent: codexAppServerUserAgent(),
    }));
    connection.registerInitialized(() => {
      connection.notify("thread/name/updated", {
        threadId: "thread",
        threadName: "name",
      });
      connection.notify("thread/archived", { threadId: "thread" });
    });
    connection.registerRequest("thread/loaded/list", () => ({
      data: [],
      nextCursor: null,
    }));
    await connection.run();
    expect(sent.map(parseCodexWireMessage)).toMatchObject([
      { error: { message: "Not initialized" }, id: 1 },
      { id: 2, result: {} },
      { method: "thread/archived", params: { threadId: "thread" } },
      { error: { message: "Already initialized" }, id: 3 },
      { id: 4, result: { data: [] } },
    ]);
  });
});
