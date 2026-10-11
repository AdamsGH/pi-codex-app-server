/* oxlint-disable anti-slop/no-module-mocking -- Replace the Pi session creation boundary to exercise turn lifecycle without providers, credentials, or user extensions. */

import {
  AgentSession,
  SessionManager,
  createExtensionRuntime,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentSessionEvent,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppServerConfig } from "../src/config/app-server-config.js";
import { appServerLogger } from "../src/logging/app-server-logger.js";
import { PiLiveSessionManager } from "../src/pi/live-session-manager.js";
import { PiModelCatalog } from "../src/pi/model-catalog.js";
import { PiModelRuntime } from "../src/pi/pi-model-runtime.js";
import { PiSessionRepository } from "../src/pi/session-repository.js";
import { PiThreadCatalog } from "../src/pi/thread-catalog.js";
import { JsonRpcConnection } from "../src/protocol/json-rpc-connection.js";
import {
  parseCodexWireMessage,
  parseServerNotification,
} from "../src/protocol/validation.js";
import { RemoteClientTransport } from "../src/remote/client-transport.js";
import { AppServer } from "../src/server/app-server.js";
import { MetadataDatabase } from "../src/storage/metadata-database.js";
import { AsyncMessageQueue } from "../src/transports/async-message-queue.js";
import type { ServerNotification } from "../vendor/openai-codex-app-server-protocol/typescript/ServerNotification.js";
import type { Thread } from "../vendor/openai-codex-app-server-protocol/typescript/v2/Thread.js";

const mocks = vi.hoisted(() => ({
  createSession: vi.fn<typeof createAgentSession>(),
}));
vi.mock(import("@earendil-works/pi-coding-agent"), async (importOriginal) => ({
  ...(await importOriginal()),
  createAgentSession: mocks.createSession,
}));

const databases: MetadataDatabase[] = [];

type SessionListener = (event: AgentSessionEvent) => void;

const createConnection = (
  notifications: ServerNotification[]
): JsonRpcConnection =>
  new JsonRpcConnection({
    clientId: "turn-test",
    logger: appServerLogger,
    transport: new RemoteClientTransport((message) => {
      notifications.push(
        parseServerNotification(parseCodexWireMessage(message))
      );
      return Promise.resolve();
    }),
  });

const fixture = () => {
  const database = new MetadataDatabase(":memory:");
  databases.push(database);
  const modelRuntime: PiModelRuntime = Object.create(PiModelRuntime.prototype);
  const modelCatalog = new PiModelCatalog(modelRuntime);
  const sessionRepository = new PiSessionRepository(database);
  const sessionManager = SessionManager.inMemory("/synthetic");
  vi.spyOn(sessionRepository, "load").mockResolvedValue(sessionManager);
  const threadCatalog = new PiThreadCatalog({ database, sessionRepository });
  const manager = new PiLiveSessionManager({
    modelCatalog,
    modelRuntime,
    sessionRepository,
    threadCatalog,
  });
  let listener: SessionListener | undefined;
  const unsubscribe = vi.fn<() => undefined>();
  const completion = Promise.withResolvers<undefined>();
  const prompt = vi.fn<AgentSession["prompt"]>(async () => {
    await completion.promise;
  });
  const abort = vi.fn<AgentSession["abort"]>(() => {
    completion.resolve();
    return Promise.resolve();
  });
  const session: AgentSession = Object.create(AgentSession.prototype);
  Object.defineProperties(session, {
    abort: { value: abort },
    isStreaming: { value: false },
    prompt: { value: prompt },
    sessionManager: { value: sessionManager },
    subscribe: {
      // eslint-disable-next-line promise/prefer-await-to-callbacks -- Pi exposes session events through a synchronous subscriber callback.
      value: (callback: SessionListener) => {
        listener = callback;
        return unsubscribe;
      },
    },
  });
  mocks.createSession.mockResolvedValue({
    extensionsResult: {
      errors: [],
      extensions: [],
      runtime: createExtensionRuntime(),
    },
    session,
  });
  const notifications: ServerNotification[] = [];
  const connection = createConnection(notifications);
  return {
    abort,
    completion,
    connection,
    database,
    emit: (event: AgentSessionEvent) => listener?.(event),
    manager,
    modelCatalog,
    modelRuntime,
    notifications,
    prompt,
    sessionManager,
    sessionRepository,
    threadCatalog,
    unsubscribe,
  };
};

const assistantEnd = (
  stopReason: "stop" | "error" | "aborted"
): AgentSessionEvent => ({
  message: {
    api: "openai-responses",
    content: [],
    errorMessage: stopReason === "error" ? "Provider failed" : undefined,
    model: "synthetic",
    provider: "synthetic",
    role: "assistant",
    stopReason,
    timestamp: 1,
    usage: {
      cacheRead: 0,
      cacheWrite: 0,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
      input: 0,
      output: 0,
      totalTokens: 0,
    },
  },
  type: "message_end",
});

describe("Pi live turn lifecycle", () => {
  afterEach(() => {
    for (const database of databases.splice(0)) {
      database.close();
    }
    vi.restoreAllMocks();
    mocks.createSession.mockReset();
  });

  it("reports prompt rejection as failed with its error", async () => {
    const { completion, connection, manager, notifications, unsubscribe } =
      fixture();
    await manager.startTurn(
      {
        input: [{ text: "hello", text_elements: [], type: "text" }],
        threadId: "thread",
      },
      connection
    );
    completion.reject(new Error("No credentials"));
    await vi.waitFor(() =>
      expect(notifications.at(-1)).toMatchObject({
        method: "turn/completed",
        params: {
          turn: { error: { message: "No credentials" }, status: "failed" },
        },
      })
    );
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it.each(["stop", "error", "aborted"] as const)(
    "projects the final assistant stop reason %s",
    async (stopReason) => {
      const { completion, connection, emit, manager, notifications } =
        fixture();
      await manager.startTurn({ input: [], threadId: "thread" }, connection);
      emit(assistantEnd(stopReason));
      completion.resolve();
      const status = {
        aborted: "interrupted",
        error: "failed",
        stop: "completed",
      }[stopReason];
      await vi.waitFor(() =>
        expect(notifications.at(-1)).toMatchObject({
          method: "turn/completed",
          params: { turn: { status } },
        })
      );
      expect(notifications.at(-1)).toMatchObject({
        params: {
          turn: {
            error:
              stopReason === "error" ? { message: "Provider failed" } : null,
          },
        },
      });
    }
  );

  it("reports cancellation as interrupted when Pi resolves abort normally", async () => {
    const { abort, connection, manager, notifications } = fixture();
    const turn = await manager.startTurn(
      { input: [], threadId: "thread" },
      connection
    );
    await manager.interrupt("thread", turn.id);
    await vi.waitFor(() =>
      expect(notifications.at(-1)).toMatchObject({
        params: { turn: { error: null, status: "interrupted" } },
      })
    );
    expect(abort).toHaveBeenCalledOnce();
  });

  it("reports success after Pi recovers from a failed model attempt", async () => {
    const { completion, connection, emit, manager, notifications } = fixture();
    await manager.startTurn({ input: [], threadId: "thread" }, connection);
    emit(assistantEnd("error"));
    emit(assistantEnd("stop"));
    completion.resolve();
    await vi.waitFor(() =>
      expect(notifications.at(-1)).toMatchObject({
        method: "turn/completed",
        params: { turn: { error: null, status: "completed" } },
      })
    );
  });

  it("delivers completion to the resumed connection and permits the next turn", async () => {
    const { completion, connection, manager, notifications } = fixture();
    await manager.startTurn({ input: [], threadId: "thread" }, connection);
    const resumedNotifications: ServerNotification[] = [];
    const resumed = createConnection(resumedNotifications);
    manager.rebindConnection("thread", resumed);
    completion.resolve();
    await vi.waitFor(() =>
      expect(resumedNotifications.at(-1)).toMatchObject({
        method: "turn/completed",
      })
    );
    expect(
      notifications.some(
        (notification) => notification.method === "turn/completed"
      )
    ).toBeFalsy();
    await expect(
      manager.startTurn({ input: [], threadId: "thread" }, resumed)
    ).resolves.toMatchObject({ status: "inProgress" });
  });

  it("resumes a live turn with stable item IDs after events hit a closed stream", async () => {
    const {
      completion,
      connection,
      database,
      emit,
      manager,
      modelCatalog,
      modelRuntime,
      notifications,
      sessionManager,
      sessionRepository,
      threadCatalog,
    } = fixture();
    const historicalId = sessionManager.appendMessage({
      content: "previous",
      role: "user",
      timestamp: 0,
    });
    const turn = await manager.startTurn(
      { input: [], threadId: "thread" },
      connection
    );
    connection.close();
    const final = assistantEnd("stop");
    if (final.type !== "message_end" || final.message.role !== "assistant") {
      throw new Error("Expected assistant message fixture");
    }
    const partial = final.message;
    emit({
      assistantMessageEvent: { contentIndex: 0, partial, type: "text_start" },
      message: partial,
      type: "message_update",
    });
    emit({
      assistantMessageEvent: {
        contentIndex: 0,
        delta: "before resume",
        partial,
        type: "text_delta",
      },
      message: partial,
      type: "message_update",
    });
    const thread: Thread = {
      agentNickname: null,
      agentRole: null,
      canAcceptDirectInput: true,
      cliVersion: "test",
      createdAt: 0,
      cwd: "/synthetic",
      ephemeral: true,
      extra: null,
      forkedFromId: null,
      gitInfo: null,
      historyMode: "legacy",
      id: "thread",
      modelProvider: "pi",
      name: null,
      parentThreadId: null,
      path: null,
      preview: "previous",
      projectId: null,
      recencyAt: 0,
      section: null,
      sectionEnteredAt: null,
      sessionId: "thread",
      source: { custom: "pi" },
      status: { type: "idle" },
      threadSource: "pi",
      turns: [],
      updatedAt: 0,
    };
    thread.turns = [
      {
        ...structuredClone(turn),
        id: historicalId,
        items: [],
        status: "completed",
      },
      { ...structuredClone(turn), id: "projected-live-id", items: [] },
    ];
    vi.spyOn(threadCatalog, "read").mockResolvedValue(thread);
    const config: AppServerConfig = {
      autoStart: false,
      hostName: "test",
      listenUrl: new URL("ws://127.0.0.1:0"),
      paths: {
        database: ":memory:",
        endpoint: "/synthetic/endpoint.json",
        home: "/synthetic",
        logs: "/synthetic/logs",
      },
      piAgentDir: "/synthetic",
      remoteControl: {
        baseUrl: new URL("https://example.invalid/"),
        enabled: false,
      },
    };
    const server = new AppServer({
      config,
      database,
      liveSessionManager: manager,
      modelCatalog,
      modelRuntime,
      sessionRepository,
      threadCatalog,
    });
    const input = new AsyncMessageQueue();
    const output: ReturnType<typeof parseCodexWireMessage>[] = [];
    const resumed = new JsonRpcConnection({
      clientId: "resumed",
      logger: appServerLogger,
      transport: {
        close: () => input.close(),
        read: () => input,
        send: (message) => {
          output.push(parseCodexWireMessage(message));
          return Promise.resolve();
        },
      },
    });
    server.register(resumed);
    const running = resumed.run();
    try {
      input.push(
        JSON.stringify({
          id: 1,
          method: "initialize",
          params: { clientInfo: { name: "test", version: "1" } },
        })
      );
      await vi.waitFor(() => expect(output).toHaveLength(1));
      input.push(
        JSON.stringify({
          id: 2,
          method: "thread/resume",
          params: { threadId: "thread" },
        })
      );
      await vi.waitFor(() => expect(output).toHaveLength(2));
      const itemId = turn.items.find(
        (item) => item.type === "agentMessage"
      )?.id;
      expect(itemId).toStrictEqual(expect.any(String));
      expect(output[1]).toMatchObject({
        id: 2,
        result: {
          thread: {
            status: { type: "active" },
            turns: [
              { id: historicalId },
              {
                id: turn.id,
                items: [
                  { type: "userMessage" },
                  { id: itemId, text: "before resume", type: "agentMessage" },
                ],
                status: "inProgress",
              },
            ],
          },
        },
      });
      emit({
        assistantMessageEvent: {
          contentIndex: 0,
          delta: " after resume",
          partial,
          type: "text_delta",
        },
        message: partial,
        type: "message_update",
      });
      completion.resolve();
      await vi.waitFor(() =>
        expect(output.at(-1)).toMatchObject({ method: "turn/completed" })
      );
      expect(output[2]).toMatchObject({
        method: "item/agentMessage/delta",
        params: { delta: " after resume", itemId, turnId: turn.id },
      });
      expect(
        notifications.some(
          (notification) =>
            notification.method === "item/started" &&
            notification.params.item.type === "agentMessage"
        )
      ).toBeFalsy();
    } finally {
      resumed.close();
      await running;
    }
  });
});
