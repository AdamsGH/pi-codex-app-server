import { existsSync } from "node:fs";
import { platform } from "node:os";
import path from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import type { InitializeParams } from "../../vendor/openai-codex-app-server-protocol/typescript/InitializeParams.js";
import type { InitializeResponse } from "../../vendor/openai-codex-app-server-protocol/typescript/InitializeResponse.js";
import type { GetAccountResponse } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/GetAccountResponse.js";
import type { ModelProviderCapabilitiesReadResponse } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/ModelProviderCapabilitiesReadResponse.js";
import type { ThreadStartParams } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/ThreadStartParams.js";
import type { ThreadStartResponse } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/ThreadStartResponse.js";
import type { TurnInterruptParams } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/TurnInterruptParams.js";
import type { TurnStartParams } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/TurnStartParams.js";
import { codexAppServerUserAgent } from "../codex-app-server-identity.js";
import type { AppServerConfig } from "../config/app-server-config.js";
import { appServerLogger } from "../logging/app-server-logger.js";
import { selectForkEntries } from "../pi/fork-entries.js";
import { paginateHistory } from "../pi/history-pagination.js";
import type { PiLiveSessionManager } from "../pi/live-session-manager.js";
import type { PiModelCatalog } from "../pi/model-catalog.js";
import type { PiModelRuntime } from "../pi/pi-model-runtime.js";
import type { PiSessionRepository } from "../pi/session-repository.js";
import { listPiSkills } from "../pi/skill-catalog.js";
import type { PiThreadCatalog } from "../pi/thread-catalog.js";
import type { JsonRpcConnection } from "../protocol/json-rpc-connection.js";
import type { MetadataDatabase } from "../storage/metadata-database.js";
import { registerHostOperations } from "./host-operations.js";
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
  readonly #newThreads = new Map<string, ThreadStartResponse>();
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
    this.#newThreads.clear();
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
    let currentCwd = process.cwd();
    if (this.#threadCatalog.publication) {
      connection.registerInitialized(async ({ signal }) => {
        this.#trackPublication(connection, signal);
        await this.#refreshPublication();
      });
    }
    connection.registerCompatibilityFallbacks();
    registerNeutralCompatibilityResponses(connection);
    registerHostOperations(connection);
    connection.registerRequest("skills/list", (params) =>
      listPiSkills(this.#config.piAgentDir, params, currentCwd)
    );
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
    connection.registerRequest("config/read", () => {
      const model = this.#modelCatalog.resolve();
      return {
        config: {
          analytics: null,
          approval_policy: "never" as const,
          approvals_reviewer: "user" as const,
          apps: null,
          browser_use: null,
          compact_prompt: null,
          computer_use: null,
          desktop: null,
          developer_instructions: null,
          forced_chatgpt_workspace_id: null,
          forced_login_method: null,
          instructions: null,
          model: model
            ? `${encodeURIComponent(model.provider)}/${encodeURIComponent(model.id)}`
            : null,
          model_auto_compact_token_limit: null,
          model_auto_compact_token_limit_scope: null,
          model_context_window: null,
          model_provider: model?.provider ?? null,
          model_reasoning_effort: null,
          model_reasoning_summary: null,
          model_verbosity: null,
          review_model: null,
          sandbox_mode: "danger-full-access" as const,
          sandbox_workspace_write: null,
          service_tier: null,
          tools: null,
          web_search: null,
        },
        layers: null,
        origins: {},
      };
    });

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
      const pending = await this.#unpersistedThread(params.threadId);
      const stored = pending
        ? undefined
        : await this.#threadCatalog.read(params.threadId, params.includeTurns);
      const thread = stored ?? pending?.thread;
      if (!thread) {
        throw new Error(`Thread not found: ${params.threadId}`);
      }
      if (params.includeTurns) {
        this.#liveSessionManager.rebindConnection(params.threadId, connection);
        await this.#liveSessionManager.attachOwner(params.threadId);
        this.#threadCatalog.publication?.retain(
          params.threadId,
          context.signal
        );
      }
      return { thread: this.#liveSessionManager.withActiveTurn(thread) };
    };
    connection.registerRequest("thread/read", readThread);
    connection.registerRequest("thread/turns/list", async (params, context) => {
      const { thread } = await readThread(
        { includeTurns: true, threadId: params.threadId },
        context
      );
      const page = paginateHistory(thread.turns, {
        cursor: params.cursor,
        direction: params.sortDirection ?? "desc",
        key: (turn) => turn.id,
        limit: params.limit,
        scope: `turns:${params.threadId}`,
      });
      return {
        ...page,
        data: page.data.map((turn) => ({
          ...turn,
          items: params.itemsView === "notLoaded" ? [] : turn.items,
          itemsView:
            params.itemsView === "notLoaded"
              ? ("notLoaded" as const)
              : ("full" as const),
        })),
      };
    });
    connection.registerRequest("thread/items/list", async (params, context) => {
      const { thread } = await readThread(
        { includeTurns: true, threadId: params.threadId },
        context
      );
      if (
        params.turnId &&
        !thread.turns.some((turn) => turn.id === params.turnId)
      ) {
        throw new Error(`Turn not found: ${params.turnId}`);
      }
      const entries = thread.turns
        .filter((turn) => !params.turnId || turn.id === params.turnId)
        .flatMap((turn) =>
          turn.items.map((item) => ({ item, turnId: turn.id }))
        );
      return paginateHistory(entries, {
        cursor: params.cursor,
        direction: params.sortDirection ?? "asc",
        key: (entry) => `${entry.turnId}:${entry.item.id}`,
        limit: params.limit,
        scope: `items:${params.threadId}:${params.turnId ?? "all"}`,
      });
    });

    const startThread = async (
      params: ThreadStartParams,
      context: { signal: AbortSignal }
    ) => {
      await this.#threadCatalog.publication?.assertCanStart(
        path.resolve(params.cwd ?? process.cwd())
      );
      const threadStartResponse = await this.#liveSessionManager.start(params);
      currentCwd = threadStartResponse.cwd;
      this.#newThreads.set(threadStartResponse.thread.id, threadStartResponse);
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
      this.#liveSessionManager.rebindConnection(params.threadId, connection);
      await this.#liveSessionManager.attachOwner(params.threadId);
      const pending = await this.#unpersistedThread(params.threadId);
      if (pending) {
        currentCwd = pending.cwd;
        this.#threadCatalog.publication?.retain(
          params.threadId,
          context.signal
        );
        this.#liveSessionManager.rebindConnection(params.threadId, connection);
        return {
          ...pending,
          initialTurnsPage: null,
          itemsBackwardsCursor: null,
          thread: this.#liveSessionManager.withActiveTurn(pending.thread),
          turnsBackwardsCursor: null,
        };
      }
      const sessionManager = await this.#sessionRepository.load(
        params.threadId
      );
      const thread = await this.#threadCatalog.read(params.threadId, true);
      if (!(sessionManager && thread)) {
        throw new Error(`Thread not found: ${params.threadId}`);
      }
      this.#threadCatalog.publication?.retain(params.threadId, context.signal);
      this.#liveSessionManager.rebindConnection(params.threadId, connection);
      currentCwd = sessionManager.getCwd();
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

    connection.registerRequest("thread/fork", async (params, context) => {
      if (params.ephemeral) {
        throw new Error("Ephemeral Pi forks are not supported");
      }
      const source = params.path
        ? SessionManager.open(params.path)
        : await this.#sessionRepository.load(params.threadId);
      if (
        !source ||
        !(await this.#threadCatalog.read(source.getSessionId(), true))
      ) {
        throw new Error(`Thread not found: ${params.threadId}`);
      }
      if (
        !params.beforeTurnId &&
        !params.lastTurnId &&
        this.#liveSessionManager.isWorking(source.getSessionId())
      ) {
        throw new Error("Cannot fork a Pi thread while its turn is running");
      }
      const entries = selectForkEntries(
        source,
        params.lastTurnId,
        params.beforeTurnId
      );
      const cwd = path.resolve(params.cwd ?? source.getCwd());
      await this.#threadCatalog.publication?.assertCanStart(cwd);
      if (params.model && !this.#modelCatalog.resolve(params.model)) {
        throw new Error(`Unknown Pi model: ${params.model}`);
      }
      const threadId = await this.#sessionRepository.fork(source, entries, cwd);
      const manager = await this.#sessionRepository.load(threadId);
      if (params.model && manager) {
        const model = this.#modelCatalog.resolve(params.model);
        if (model) {
          manager.appendModelChange(model.provider, model.id);
        }
      }
      const response = await resumeThread({ threadId }, context);
      response.thread.forkedFromId = source.getSessionId();
      if (params.excludeTurns) {
        response.thread.turns = [];
      }
      connection.notify("thread/started", { thread: response.thread });
      return response;
    });

    connection.registerRequest("thread/loaded/list", (params) =>
      this.#liveSessionManager.loadedList(params)
    );

    const setThreadName = async (params: {
      readonly name: string;
      readonly threadId: string;
    }): Promise<Record<string, never>> => {
      this.#liveSessionManager.rebindConnection(params.threadId, connection);
      await this.#liveSessionManager.setName(params.threadId, params.name);
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

    connection.registerRequest("thread/unsubscribe", (params, context) => {
      const detached = this.#liveSessionManager.detach(
        params.threadId,
        connection
      );
      const released = this.#threadCatalog.publication?.release(
        params.threadId,
        context.signal
      );
      return {
        status: detached || released ? "unsubscribed" : "notSubscribed",
      };
    });

    const startTurn = async (
      params: TurnStartParams,
      context: { signal: AbortSignal }
    ) => {
      if (
        !(await this.#unpersistedThread(params.threadId)) &&
        !(await this.#threadCatalog.read(params.threadId))
      ) {
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
      const release = await this.#liveSessionManager.deletionLease(
        params.threadId
      );
      try {
        if (
          !(await this.#unpersistedThread(params.threadId)) &&
          !(await this.#sessionRepository.delete(params.threadId))
        ) {
          throw new Error(`Thread not found: ${params.threadId}`);
        }
        this.#liveSessionManager.unload(params.threadId);
        this.#newThreads.delete(params.threadId);
        return {};
      } finally {
        await release();
      }
    };
    connection.registerRequest("thread/delete", deleteThread);
  }

  async #unpersistedThread(
    id: string
  ): Promise<ThreadStartResponse | undefined> {
    const pending = this.#newThreads.get(id);
    if (!pending) {
      return undefined;
    }
    if (
      pending.thread.path &&
      (existsSync(pending.thread.path) || this.#database.getThread(id))
    ) {
      this.#newThreads.delete(id);
      return undefined;
    }
    await this.#threadCatalog.publication?.assertCanStart(pending.cwd);
    return pending;
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
