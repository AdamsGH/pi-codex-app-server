import { randomUUID } from "node:crypto";

import type {
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { z } from "zod";

import type { ThreadItem } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/ThreadItem.js";
import { projectPiConversation } from "../pi/conversation-projector.js";
import { images, textPrompt } from "../pi/live-session-manager.js";
import {
  emptyTurn,
  finishTurn,
  handleEvent,
  notifyItemStarted,
  notifyItemCompleted,
} from "../pi/live-turn.js";
import type { ActiveTurn } from "../pi/live-turn.js";
import { SessionOwnerHost } from "../pi/session-owner-host.js";
import type { OwnerRequest, OwnerResult } from "../pi/session-owner.js";
import {
  parseServerNotification,
  parseCodexWireMessage,
} from "../protocol/validation.js";

const userContentSchema = z.union([
  z.string().transform((text) => [{ text, type: "text" as const }]),
  z.array(
    z.discriminatedUnion("type", [
      z.object({ text: z.string(), type: z.literal("text") }),
      z.object({
        data: z.string(),
        mimeType: z.string(),
        type: z.literal("image"),
      }),
    ])
  ),
]);
const effortSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export class TuiSessionBridge {
  readonly #pi: ExtensionAPI;
  readonly #home: string;
  #host?: SessionOwnerHost;
  #context?: ExtensionContext;
  #active?: ActiveTurn;
  #last?: ActiveTurn;
  #submittedPrompt?: string;
  #stopping = false;
  #publishedName?: string;
  #clientMessageId: string | null = null;
  #skipUserMessages = 0;
  #acceptanceTimer?: ReturnType<typeof setTimeout>;
  constructor(pi: ExtensionAPI, home: string) {
    this.#pi = pi;
    this.#home = home;
  }
  async start(context: ExtensionContext): Promise<void> {
    await this.stop();
    this.#context = context;
    this.#stopping = false;
    const host = new SessionOwnerHost({
      handle: (request) => this.#command(request),
      home: this.#home,
      snapshot: () => {
        const active = this.#active ?? this.#last;
        return {
          historyTurnCount: active?.historyTurnCount ?? 0,
          turn: active?.turn ?? null,
        };
      },
      threadId: context.sessionManager.getSessionId(),
    });
    await host.start();
    this.#host = host;
  }
  guardInput(
    event: InputEvent,
    context: ExtensionContext
  ): { action: "handled" } | undefined {
    if (
      this.#submittedPrompt === undefined ||
      !context.isIdle() ||
      (event.source === "extension" && event.text === this.#submittedPrompt)
    ) {
      return undefined;
    }
    context.ui.notify(
      "A remote message is being prepared. Wait for it to start before sending another message.",
      "warning"
    );
    if (event.source === "interactive") {
      context.ui.setEditorText(event.text);
    }
    return { action: "handled" };
  }
  nameChanged(): void {
    const name = this.#pi.getSessionName();
    if (name === this.#publishedName || !this.#context) {
      return;
    }
    this.#publishedName = name;
    this.#host?.publish({
      method: "thread/name/updated",
      params: {
        threadId: this.#context.sessionManager.getSessionId(),
        threadName: name,
      },
    });
  }
  refresh(): void {
    if (!this.#active) {
      this.#last = undefined;
    }
    this.#host?.publishSnapshot();
  }
  get ownsSession(): boolean {
    return this.#host !== undefined;
  }
  #begin(rootTurnId?: string | null): ActiveTurn {
    const context = this.#context;
    if (!(context && this.#host)) {
      throw new Error("Pi TUI has no session lease");
    }
    const active: ActiveTurn = {
      agentItems: new Map(),
      connection: {
        notify: (method, params) =>
          this.#host?.publish(
            parseServerNotification(
              parseCodexWireMessage(JSON.stringify({ method, params }))
            )
          ),
      },
      historyTurnCount: projectPiConversation(
        context.sessionManager.getBranch(),
        context.cwd
      ).length,
      interrupted: false,
      reasoningItems: new Map(),
      startedAtMs: Date.now(),
      threadId: context.sessionManager.getSessionId(),
      toolItems: new Map(),
      turn: emptyTurn(rootTurnId),
    };
    this.#active = active;
    active.connection.notify("turn/started", {
      threadId: active.threadId,
      turn: active.turn,
    });
    return active;
  }
  event(event: AgentSessionEvent): void {
    if (!this.#host) {
      return;
    }
    if (event.type === "agent_start") {
      clearTimeout(this.#acceptanceTimer);
      this.#submittedPrompt = undefined;
      this.#active ??= this.#begin();
    }
    if (event.type === "message_start" && event.message.role === "user") {
      const active = this.#active ?? this.#begin();
      if (this.#skipUserMessages > 0) {
        this.#skipUserMessages -= 1;
        return;
      }
      const content = userContentSchema
        .parse(event.message.content)
        .map((part) =>
          part.type === "text"
            ? { text: part.text, text_elements: [], type: "text" as const }
            : {
                type: "image" as const,
                url: `data:${part.mimeType};base64,${part.data}`,
              }
        );
      const item: ThreadItem = {
        clientId: this.#clientMessageId,
        content,
        id: randomUUID(),
        type: "userMessage",
      };
      this.#clientMessageId = null;
      notifyItemStarted(active, item);
      notifyItemCompleted(active, item);
    }
    const active = this.#active;
    if (!active) {
      return;
    }
    handleEvent(active, event);
    if (event.type === "message_end" && event.message.role === "assistant") {
      active.agentItems.clear();
      active.reasoningItems.clear();
    }
    if (event.type === "agent_settled") {
      this.#submittedPrompt = undefined;
      clearTimeout(this.#acceptanceTimer);
      active.interrupted ||= "aborted" in event && event.aborted === true;
      this.#last = active;
      this.#active = undefined;
      this.#skipUserMessages = 0;
      finishTurn(active);
    }
  }
  async #command(request: OwnerRequest): Promise<OwnerResult> {
    const context = this.#context;
    if (!(context && this.#host) || this.#stopping) {
      throw new Error("Pi TUI owner is unavailable");
    }
    if (request.method === "thread/name/set") {
      this.#pi.setSessionName(request.params.name);
      this.nameChanged();
      return {};
    }
    if (request.method === "turn/interrupt") {
      if (this.#active?.turn.id !== request.params.turnId) {
        throw new Error("Active Pi turn changed");
      }
      this.#active.interrupted = true;
      context.abort();
      return {};
    }
    if (request.method === "thread/compact/start") {
      if (this.#active || !context.isIdle()) {
        throw new Error("Pi session is already running");
      }
      context.compact();
      return {};
    }
    if (request.method === "turn/steer") {
      return await this.#steer(request, context);
    }
    return await this.#startPrompt(request, context);
  }
  async #startPrompt(
    request: Extract<OwnerRequest, { method: "turn/start" }>,
    context: ExtensionContext
  ): Promise<OwnerResult> {
    if (this.#active || !context.isIdle()) {
      throw new Error("Pi session is already running");
    }
    const active = this.#begin(request.params.rootTurnId);
    this.#submittedPrompt = textPrompt(request.params.input);
    try {
      const inputImages = await images(request.params.input);
      if (request.params.model) {
        const model = context.modelRegistry
          .getAll()
          .find(
            (candidate) =>
              `${encodeURIComponent(candidate.provider)}/${encodeURIComponent(candidate.id)}` ===
              request.params.model
          );
        if (!model || !(await this.#pi.setModel(model))) {
          throw new Error(`Pi model is unavailable: ${request.params.model}`);
        }
      }
      if (this.#stopping) {
        throw new Error("Pi session owner is shutting down");
      }
      if (request.params.effort) {
        this.#pi.setThinkingLevel(effortSchema.parse(request.params.effort));
      }
      this.#clientMessageId = request.params.clientUserMessageId ?? null;
      this.#acceptanceTimer = setTimeout(() => {
        if (this.#active === active && context.isIdle()) {
          this.#submittedPrompt = undefined;
          active.failure = new Error("Pi did not start the submitted message");
          this.#last = active;
          this.#active = undefined;
          finishTurn(active);
        }
      }, 5000);
      this.#pi.sendUserMessage([
        { text: textPrompt(request.params.input), type: "text" },
        ...inputImages,
      ]);
      return active.turn;
    } catch (error) {
      this.#submittedPrompt = undefined;
      active.failure =
        error instanceof Error
          ? error
          : new Error("Pi rejected the submitted message");
      this.#last = active;
      this.#active = undefined;
      finishTurn(active);
      throw error;
    }
  }
  async #steer(
    request: Extract<OwnerRequest, { method: "turn/steer" }>,
    context: ExtensionContext
  ): Promise<OwnerResult> {
    const active = this.#active;
    if (
      !active ||
      active.turn.id !== request.params.expectedTurnId ||
      context.isIdle()
    ) {
      throw new Error("Active Pi turn changed");
    }
    const inputImages = await images(request.params.input);
    this.#pi.sendUserMessage(
      [
        { text: textPrompt(request.params.input), type: "text" },
        ...inputImages,
      ],
      { deliverAs: "steer" }
    );
    const item: ThreadItem = {
      clientId: request.params.clientUserMessageId ?? null,
      content: request.params.input,
      id: randomUUID(),
      type: "userMessage",
    };
    this.#skipUserMessages += 1;
    notifyItemStarted(active, item);
    notifyItemCompleted(active, item);
    return { turnId: active.turn.id };
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#submittedPrompt = undefined;
    clearTimeout(this.#acceptanceTimer);
    if (this.#active) {
      this.#active.interrupted = true;
      finishTurn(this.#active);
      this.#context?.abort();
    }
    await this.#host?.stop();
    this.#host = undefined;
    this.#context = undefined;
    this.#active = undefined;
    this.#last = undefined;
    this.#skipUserMessages = 0;
    this.#publishedName = undefined;
  }
}
