import { platform } from "node:os";
import path from "node:path";

import type { InitializeParams } from "../../vendor/openai-codex-app-server-protocol/typescript/InitializeParams.js";
import type { InitializeResponse } from "../../vendor/openai-codex-app-server-protocol/typescript/InitializeResponse.js";
import type { GetAccountResponse } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/GetAccountResponse.js";
import type { ModelProviderCapabilitiesReadResponse } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/ModelProviderCapabilitiesReadResponse.js";
import type { ThreadStartParams } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/ThreadStartParams.js";
import type { TurnInterruptParams } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/TurnInterruptParams.js";
import type { TurnStartParams } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/TurnStartParams.js";
import { codexAppServerUserAgent } from "../codex-app-server-identity.js";
import type { AppServerConfig } from "../config/app-server-config.js";
import { appServerLogger } from "../logging/app-server-logger.js";
import type { PiLiveSessionManager } from "../pi/live-session-manager.js";
import type { PiModelCatalog } from "../pi/model-catalog.js";
import type { PiModelRuntime } from "../pi/pi-model-runtime.js";
import type { PiSessionRepository } from "../pi/session-repository.js";
import type { PiThreadCatalog } from "../pi/thread-catalog.js";
import type { JsonRpcConnection } from "../protocol/json-rpc-connection.js";
import type { MetadataDatabase } from "../storage/metadata-database.js";
import { registerNeutralCompatibilityResponses } from "./neutral-compatibility-responses.js";

const readModelProviderCapabilities =
  (): ModelProviderCapabilitiesReadResponse => ({
    imageGeneration: false,
    namespaceTools: false,
    webSearch: false,
  });

const platformOs = (): string => {
  const current = platform();
  if (current === "darwin") {
    return "macos";
  }
  if (current === "win32") {
    return "windows";
  }
  return current;
};

export class AppServer {
  readonly #config: AppServerConfig;
  readonly #database: MetadataDatabase;
  readonly #modelCatalog: PiModelCatalog;
  readonly #liveSessionManager: PiLiveSessionManager;
  readonly #modelRuntime: PiModelRuntime;
  readonly #sessionRepository: PiSessionRepository;
  readonly #threadCatalog: PiThreadCatalog;
  readonly #publicationClients = new Map<JsonRpcConnection, Set<string>>();
  #publicationTimer?: ReturnType<typeof setInterval>;
  #refreshing = false;
  #closed = false;

  constructor(options: {
    readonly config: AppServerConfig;
    readonly database: MetadataDatabase;
    readonly modelCatalog: PiModelCatalog;
    readonly liveSessionManager: PiLiveSessionManager;
    readonly modelRuntime: PiModelRuntime;
    readonly sessionRepository: PiSessionRepository;
    readonly threadCatalog: PiThreadCatalog;
  }) {
    this.#config = options.config;
    this.#database = options.database;
    this.#modelCatalog = options.modelCatalog;
    this.#liveSessionManager = options.liveSessionManager;
    this.#modelRuntime = options.modelRuntime;
    this.#sessionRepository = options.sessionRepository;
    this.#threadCatalog = options.threadCatalog;
  }

  close(): void {
    this.#closed = true;
    clearInterval(this.#publicationTimer);
    this.#publicationClients.clear();
    this.#liveSessionManager.close();
    this.#database.close();
  }

  get database(): MetadataDatabase {
    return this.#database;
  }

  get modelRuntime(): PiModelRuntime {
    return this.#modelRuntime;
  }

  register(connection: JsonRpcConnection): void {
    if (this.#threadCatalog.publication) {
      connection.registerInitialized(async ({ signal }) => {
        this.#trackPublication(connection, signal);
        await this.#refreshPublication();
      });
    }
    connection.registerCompatibilityFallbacks();
    registerNeutralCompatibilityResponses(connection);
    const { sections } = this.#threadCatalog;
    connection.registerRequest("threadSection/list", (params) =>
      sections.list(params)
    );
    connection.registerRequest("threadSection/create", (params) =>
      sections.create(params)
    );
    connection.registerRequest("threadSection/update", (params) =>
      sections.update(params)
    );
    connection.registerRequest("threadSection/delete", (params) =>
      sections.delete(params.sectionId)
    );
    connection.registerRequest("thread/section/move", async (params) => {
      await this.#sessionRepository.list();
      return sections.move(params);
    });

    const { projects } = this.#sessionRepository;
    connection.registerRequest("project/list", async (params) => {
      await this.#sessionRepository.list();
      return projects.list(params);
    });
    connection.registerRequest("project/read", (params) =>
      projects.read(params.projectId)
    );
    connection.registerRequest("project/create", (params) =>
      projects.create(params)
    );
    connection.registerRequest("project/import", async (params) => {
      await this.#sessionRepository.list();
      return projects.import(params);
    });
    connection.registerRequest("project/update", (params) =>
      projects.update(params)
    );
    connection.registerRequest("project/delete", (params) =>
      projects.delete(params.projectId)
    );
    connection.registerRequest("project/move", (params) =>
      projects.move(params)
    );
    connection.registerRequest("thread/metadata/update", async (params) => {
      if (params.gitInfo !== undefined && params.gitInfo !== null) {
        throw new Error("Updating Pi thread Git metadata is not supported");
      }
      await this.#sessionRepository.list();
      if (params.projectId !== undefined && params.projectId !== null) {
        projects.assign(params.threadId, params.projectId || null);
      }
      const thread = await this.#threadCatalog.read(params.threadId);
      if (!thread) {
        throw new Error(`Thread not found: ${params.threadId}`);
      }
      return { thread };
    });

    const initialize = (
      _params: InitializeParams,
      context: { signal: AbortSignal }
    ): InitializeResponse => {
      this.#trackPublication(connection, context.signal);
      const response: InitializeResponse = {
        codexHome: this.#config.paths.home,
        platformFamily: platform() === "win32" ? "windows" : "unix",
        platformOs: platformOs(),
        userAgent: codexAppServerUserAgent(),
      };
      return response;
    };
    connection.registerRequest("initialize", initialize);

    const listModels = (
      params: Parameters<PiModelCatalog["list"]>[0],
      context: { readonly signal: AbortSignal }
    ) => this.#modelCatalog.list(params, context.signal);
    connection.registerRequest("model/list", listModels);

    connection.registerRequest(
      "modelProvider/capabilities/read",
      readModelProviderCapabilities
    );

    const readAccount = (): GetAccountResponse => ({
      account: this.#modelRuntime.hasOpenAiAuthentication()
        ? { email: null, planType: "unknown", type: "chatgpt" }
        : null,
      requiresOpenaiAuth: false,
    });
    connection.registerRequest("account/read", readAccount);
    connection.registerRequest("getAuthStatus", (params, context) =>
      this.#modelRuntime.readAuthStatus(params, context.signal)
    );

    const logout = async (
      _params: undefined,
      context: { readonly signal: AbortSignal }
    ): Promise<Record<string, never>> => {
      await this.#modelRuntime.logoutOpenAi(context.signal);
      return {};
    };
    connection.registerRequest("account/logout", logout);

    const listThreads = this.#threadCatalog.list.bind(this.#threadCatalog);
    connection.registerRequest("thread/list", listThreads);

    const readThread = async (
      params: {
        readonly includeTurns?: boolean;
        readonly threadId: string;
      },
      context: { signal: AbortSignal }
    ) => {
      const thread = await this.#threadCatalog.read(
        params.threadId,
        params.includeTurns
      );
      if (!thread) {
        throw new Error(`Thread not found: ${params.threadId}`);
      }
      if (params.includeTurns) {
        this.#threadCatalog.publication?.retain(
          params.threadId,
          context.signal
        );
      }
      return { thread };
    };
    connection.registerRequest("thread/read", readThread);

    const startThread = async (
      params: ThreadStartParams,
      context: { signal: AbortSignal }
    ) => {
      await this.#threadCatalog.publication?.assertCanStart(
        path.resolve(params.cwd ?? process.cwd())
      );
      const threadStartResponse = await this.#liveSessionManager.start(params);
      this.#threadCatalog.publication?.retain(
        threadStartResponse.thread.id,
        context.signal
      );
      connection.notify("thread/started", {
        thread: threadStartResponse.thread,
      });
      return threadStartResponse;
    };
    connection.registerRequest("thread/start", startThread);

    const resumeThread = async (
      params: { readonly threadId: string },
      context: { signal: AbortSignal }
    ) => {
      const sessionManager = await this.#sessionRepository.load(
        params.threadId
      );
      const thread = await this.#threadCatalog.read(params.threadId, true);
      if (!(sessionManager && thread)) {
        throw new Error(`Thread not found: ${params.threadId}`);
      }
      this.#threadCatalog.publication?.retain(params.threadId, context.signal);
      this.#liveSessionManager.rebindConnection(params.threadId, connection);
      const sessionContext = sessionManager.buildSessionContext();
      const provider = sessionContext.model?.provider ?? "pi";
      const modelId = sessionContext.model?.modelId ?? "unknown";
      return {
        activePermissionProfile: null,
        approvalPolicy: "never" as const,
        approvalsReviewer: "user" as const,
        cwd: sessionManager.getCwd(),
        initialTurnsPage: null,
        instructionSources: [],
        itemsBackwardsCursor: null,
        model: `${encodeURIComponent(provider)}/${encodeURIComponent(modelId)}`,
        modelProvider: provider,
        multiAgentMode: "explicitRequestOnly" as const,
        reasoningEffort: sessionContext.thinkingLevel,
        runtimeWorkspaceRoots: [sessionManager.getCwd()],
        sandbox: { type: "dangerFullAccess" as const },
        serviceTier: null,
        thread: this.#liveSessionManager.withActiveTurn(thread),
        turnsBackwardsCursor: null,
      };
    };
    connection.registerRequest("thread/resume", resumeThread);

    connection.registerRequest("thread/loaded/list", (params) =>
      this.#liveSessionManager.loadedList(params)
    );

    const setThreadName = async (params: {
      readonly name: string;
      readonly threadId: string;
    }): Promise<Record<string, never>> => {
      const sessionManager = await this.#sessionRepository.load(
        params.threadId
      );
      if (!sessionManager) {
        throw new Error(`Thread not found: ${params.threadId}`);
      }
      sessionManager.appendSessionInfo(params.name);
      connection.notify("thread/name/updated", {
        threadId: params.threadId,
        threadName: params.name || undefined,
      });
      return {};
    };
    connection.registerRequest("thread/name/set", setThreadName);

    const compactThread = async (params: {
      readonly threadId: string;
    }): Promise<Record<string, never>> => {
      await this.#liveSessionManager.compact(params.threadId);
      return {};
    };
    connection.registerRequest("thread/compact/start", compactThread);

    connection.registerRequest("thread/unsubscribe", (params, context) => ({
      status: this.#threadCatalog.publication?.release(
        params.threadId,
        context.signal
      )
        ? "unsubscribed"
        : "notSubscribed",
    }));

    const startTurn = async (
      params: TurnStartParams,
      context: { signal: AbortSignal }
    ) => {
      if (!(await this.#threadCatalog.read(params.threadId))) {
        throw new Error(`Thread not published: ${params.threadId}`);
      }
      this.#threadCatalog.publication?.retain(params.threadId, context.signal);
      return {
        turn: await this.#liveSessionManager.startTurn(params, connection),
      };
    };
    connection.registerRequest("turn/start", startTurn);

    const steerTurn = this.#liveSessionManager.steer.bind(
      this.#liveSessionManager
    );
    connection.registerRequest("turn/steer", steerTurn);

    const interruptTurn = async (params: TurnInterruptParams) => {
      await this.#liveSessionManager.interrupt(params.threadId, params.turnId);
      return {};
    };
    connection.registerRequest("turn/interrupt", interruptTurn);

    const archiveThread = (params: { readonly threadId: string }) => {
      if (!this.#database.setThreadArchived(params.threadId, true)) {
        throw new Error(`Thread not found: ${params.threadId}`);
      }
      return {};
    };
    connection.registerRequest("thread/archive", archiveThread);

    const unarchiveThread = async (params: { readonly threadId: string }) => {
      if (!this.#database.setThreadArchived(params.threadId, false)) {
        throw new Error(`Thread not found: ${params.threadId}`);
      }
      const thread = await this.#threadCatalog.read(params.threadId);
      if (!thread) {
        throw new Error(`Thread not found after unarchive: ${params.threadId}`);
      }
      return { thread };
    };
    connection.registerRequest("thread/unarchive", unarchiveThread);

    const deleteThread = async (params: {
      readonly threadId: string;
    }): Promise<Record<string, never>> => {
      if (!(await this.#sessionRepository.delete(params.threadId))) {
        throw new Error(`Thread not found: ${params.threadId}`);
      }
      return {};
    };
    connection.registerRequest("thread/delete", deleteThread);
  }

  #trackPublication(connection: JsonRpcConnection, signal: AbortSignal): void {
    if (
      !this.#threadCatalog.publication ||
      signal.aborted ||
      this.#publicationClients.has(connection)
    ) {
      return;
    }
    this.#publicationClients.set(
      connection,
      new Set(this.#database.listThreads().map(({ threadId }) => threadId))
    );
    signal.addEventListener(
      "abort",
      () => {
        this.#publicationClients.delete(connection);
        if (this.#publicationClients.size === 0) {
          clearInterval(this.#publicationTimer);
          this.#publicationTimer = undefined;
        }
      },
      { once: true }
    );
    this.#publicationTimer ??= setInterval(async () => {
      try {
        await this.#refreshPublication();
      } catch (error) {
        appServerLogger.warn(
          error instanceof Error
            ? error
            : new Error("Session publication refresh failed")
        );
      }
    }, 5000);
    this.#publicationTimer.unref();
  }

  async #refreshPublication(): Promise<void> {
    if (this.#refreshing || this.#closed) {
      return;
    }
    this.#refreshing = true;
    try {
      const all = await this.#sessionRepository.list();
      let visible = all;
      try {
        visible = (await this.#threadCatalog.publication?.select(all)) ?? all;
      } catch (error) {
        appServerLogger.warn(
          error instanceof Error
            ? error
            : new Error("Invalid session publication settings")
        );
        visible = [];
      }
      if (this.#closed) {
        return;
      }
      const current = new Set(visible.map(({ id }) => id));
      for (const [connection, previous] of this.#publicationClients) {
        for (const threadId of previous) {
          if (!current.has(threadId)) {
            connection.notify("thread/deleted", { threadId });
          }
        }
        for (const threadId of current) {
          if (!previous.has(threadId)) {
            const session = visible.find(({ id }) => id === threadId);
            if (session) {
              const thread = this.#threadCatalog.describe(session);
              connection.notify("thread/started", { thread });
              if (this.#database.getThread(threadId)?.archived) {
                connection.notify("thread/archived", { threadId });
              }
            }
          }
        }
        this.#publicationClients.set(connection, current);
      }
    } finally {
      this.#refreshing = false;
    }
  }
}
