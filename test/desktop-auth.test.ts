import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import type { AppServerConfig } from "../src/config/app-server-config.js";
import { appServerLogger } from "../src/logging/app-server-logger.js";
import { PiLiveSessionManager } from "../src/pi/live-session-manager.js";
import { PiModelCatalog } from "../src/pi/model-catalog.js";
import {
  PiModelRuntime,
  OPENAI_CODEX_PROVIDER,
} from "../src/pi/pi-model-runtime.js";
import { PiSessionRepository } from "../src/pi/session-repository.js";
import { PiThreadCatalog } from "../src/pi/thread-catalog.js";
import { JsonRpcConnection } from "../src/protocol/json-rpc-connection.js";
import type { CodexWireMessage } from "../src/protocol/validation.js";
import { parseCodexWireMessage } from "../src/protocol/validation.js";
import { AppServer } from "../src/server/app-server.js";
import { MetadataDatabase } from "../src/storage/metadata-database.js";

describe("desktop authentication handshake", () => {
  test("accepts the desktop bootstrap and exposes tokens only when requested", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "pi-desktop-auth-"));
    const database = new MetadataDatabase(":memory:");
    const config: AppServerConfig = {
      autoStart: false,
      hostName: "test",
      listenUrl: new URL("ws://127.0.0.1:0"),
      paths: {
        database: ":memory:",
        endpoint: path.join(home, "endpoint.json"),
        home,
        logs: path.join(home, "logs"),
      },
      piAgentDir: home,
      remoteControl: {
        baseUrl: new URL("https://chatgpt.com/backend-api/"),
        enabled: false,
      },
    };
    try {
      const modelRuntime = await PiModelRuntime.create(config);
      vi.spyOn(modelRuntime, "hasOpenAiAuthentication").mockReturnValue(true);
      vi.spyOn(modelRuntime.modelRuntime, "isUsingOAuth").mockReturnValue(true);
      const getAuth = vi
        .spyOn(modelRuntime.modelRuntime, "getAuth")
        .mockResolvedValue({ auth: { apiKey: "fixture-token" } });
      const modelCatalog = new PiModelCatalog(modelRuntime);
      const sessionRepository = new PiSessionRepository(database);
      const threadCatalog = new PiThreadCatalog({
        database,
        sessionRepository,
      });
      const liveSessionManager = new PiLiveSessionManager({
        modelCatalog,
        modelRuntime,
        sessionRepository,
        threadCatalog,
      });
      const server = new AppServer({
        config,
        database,
        liveSessionManager,
        modelCatalog,
        modelRuntime,
        sessionRepository,
        threadCatalog,
      });
      const responses: CodexWireMessage[] = [];
      const connection = new JsonRpcConnection({
        clientId: "desktop-test",
        logger: appServerLogger,
        transport: {
          close: () => {},
          read: async function* read() {
            yield JSON.stringify({
              id: 0,
              method: "initialize",
              params: { clientInfo: { name: "desktop", version: "1" } },
            });
            yield JSON.stringify({ method: "initialized" });
            yield JSON.stringify({
              id: 1,
              method: "getAuthStatus",
              params: { includeToken: false, refreshToken: false },
            });
            expect(getAuth).not.toHaveBeenCalled();
            yield JSON.stringify({
              id: 2,
              method: "configRequirements/read",
              params: {},
            });
            yield JSON.stringify({
              id: 3,
              method: "getAuthStatus",
              params: { includeToken: true, refreshToken: false },
            });
            yield JSON.stringify({
              id: 4,
              method: "getAuthStatus",
              params: { includeToken: false, refreshToken: true },
            });
            yield JSON.stringify({
              id: 5,
              method: "getAuthStatus",
              params: { includeToken: "yes", refreshToken: false },
            });
          },
          send: (message) => {
            responses.push(parseCodexWireMessage(message));
            return Promise.resolve();
          },
        },
      });
      server.register(connection);
      await connection.run();
      expect(responses.slice(1)).toMatchObject([
        {
          id: 1,
          result: {
            authMethod: "chatgpt",
            authToken: null,
            requiresOpenaiAuth: false,
          },
        },
        { id: 2, result: { requirements: null } },
        {
          id: 3,
          result: {
            authMethod: "chatgpt",
            authToken: "fixture-token",
            requiresOpenaiAuth: false,
          },
        },
        { id: 4, result: { authToken: null } },
        { error: { code: -32_602 }, id: 5 },
      ]);
      expect(getAuth.mock.calls).toStrictEqual([
        [OPENAI_CODEX_PROVIDER, { signal: expect.any(AbortSignal) }],
        [OPENAI_CODEX_PROVIDER, { signal: expect.any(AbortSignal) }],
      ]);
      vi.spyOn(modelRuntime, "hasOpenAiAuthentication").mockReturnValue(false);
      await expect(
        modelRuntime.readAuthStatus({
          includeToken: false,
          refreshToken: false,
        })
      ).resolves.toStrictEqual({
        authMethod: null,
        authToken: null,
        requiresOpenaiAuth: false,
      });
      liveSessionManager.close();
    } finally {
      database.close();
      vi.restoreAllMocks();
      await rm(home, { force: true, recursive: true });
    }
  });
});
