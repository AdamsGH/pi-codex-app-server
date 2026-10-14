import { randomUUID } from "node:crypto";

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { z } from "zod";

import type { ThreadItem } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/ThreadItem.js";
import type { Turn } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/Turn.js";
import type { JsonRpcConnection } from "../protocol/json-rpc-connection.js";

const toolResultTextSchema = z.union([
  z.string(),
  z.json().transform((value) => JSON.stringify(value)),
]);
export interface ActiveTurn {
  readonly historyTurnCount: number;
  interrupted: boolean;
  failure?: Error;
  readonly agentItems: Map<
    number,
    Extract<ThreadItem, { type: "agentMessage" }>
  >;
  connection: Pick<JsonRpcConnection, "notify">;
  readonly reasoningItems: Map<
    number,
    Extract<ThreadItem, { type: "reasoning" }>
  >;
  readonly startedAtMs: number;
  readonly threadId: string;
  readonly toolItems: Map<
    string,
    Extract<ThreadItem, { type: "dynamicToolCall" }>
  >;
  readonly turn: Turn;
  unsubscribe?: () => void;
}

export const emptyTurn = (rootTurnId?: string | null): Turn => {
  const startedAt = Date.now();
  const id = randomUUID();
  return {
    completedAt: null,
    durationMs: null,
    error: null,
    id,
    items: [],
    itemsView: "full",
    rootTurnId: rootTurnId ?? id,
    startedAt: Math.floor(startedAt / 1000),
    status: "inProgress",
  };
};

export const notifyItemStarted = (
  active: ActiveTurn,
  item: ThreadItem
): void => {
  active.turn.items.push(item);
  active.connection.notify("item/started", {
    item,
    startedAtMs: Date.now(),
    threadId: active.threadId,
    turnId: active.turn.id,
  });
};

export const notifyItemCompleted = (
  active: ActiveTurn,
  item: ThreadItem
): void => {
  active.connection.notify("item/completed", {
    completedAtMs: Date.now(),
    item,
    threadId: active.threadId,
    turnId: active.turn.id,
  });
};

const handleMessageUpdate = (
  active: ActiveTurn,
  event: Extract<AgentSessionEvent, { type: "message_update" }>
): void => {
  const update = event.assistantMessageEvent;
  if (update.type === "text_start") {
    const item = {
      delivery: null,
      id: randomUUID(),
      memoryCitation: null,
      phase: null,
      questions: null,
      text: "",
      type: "agentMessage" as const,
    };
    active.agentItems.set(update.contentIndex, item);
    notifyItemStarted(active, item);
  } else if (update.type === "text_delta") {
    const item = active.agentItems.get(update.contentIndex);
    if (item) {
      item.text += update.delta;
      active.connection.notify("item/agentMessage/delta", {
        delta: update.delta,
        itemId: item.id,
        threadId: active.threadId,
        turnId: active.turn.id,
      });
    }
  } else if (update.type === "text_end") {
    const item = active.agentItems.get(update.contentIndex);
    if (item) {
      item.text = update.content;
      notifyItemCompleted(active, item);
    }
  } else if (update.type === "thinking_start") {
    const item = {
      content: [""],
      id: randomUUID(),
      summary: [],
      type: "reasoning" as const,
    };
    active.reasoningItems.set(update.contentIndex, item);
    notifyItemStarted(active, item);
  } else if (update.type === "thinking_delta") {
    const item = active.reasoningItems.get(update.contentIndex);
    if (item) {
      item.content[0] += update.delta;
      active.connection.notify("item/reasoning/textDelta", {
        contentIndex: 0,
        delta: update.delta,
        itemId: item.id,
        threadId: active.threadId,
        turnId: active.turn.id,
      });
    }
  } else if (update.type === "thinking_end") {
    const item = active.reasoningItems.get(update.contentIndex);
    if (item) {
      item.content[0] = update.content;
      notifyItemCompleted(active, item);
    }
  }
};

const handleToolEvent = (
  active: ActiveTurn,
  event: AgentSessionEvent
): void => {
  if (event.type === "tool_execution_start") {
    const item: Extract<ThreadItem, { type: "dynamicToolCall" }> = {
      arguments: z.json().parse(event.args),
      contentItems: null,
      durationMs: null,
      id: event.toolCallId,
      namespace: null,
      status: "inProgress",
      success: null,
      tool: event.toolName,
      type: "dynamicToolCall",
    };
    active.toolItems.set(event.toolCallId, item);
    notifyItemStarted(active, item);
  } else if (event.type === "tool_execution_end") {
    const item = active.toolItems.get(event.toolCallId);
    if (item) {
      const parsedResult = toolResultTextSchema.safeParse(event.result);
      item.status = event.isError ? "failed" : "completed";
      item.success = !event.isError;
      item.contentItems = [
        {
          text: parsedResult.success
            ? parsedResult.data
            : "[Unserializable tool result]",
          type: "inputText",
        },
      ];
      notifyItemCompleted(active, item);
    }
  }
};

export const handleEvent = (
  active: ActiveTurn,
  event: AgentSessionEvent
): void => {
  if (event.type === "message_end" && event.message.role === "assistant") {
    if (event.message.stopReason === "aborted") {
      active.interrupted = true;
    } else if (event.message.stopReason === "error") {
      active.failure = new Error(
        event.message.errorMessage ?? "Pi model request failed"
      );
    } else {
      active.failure = undefined;
    }
  }
  if (event.type === "message_update") {
    handleMessageUpdate(active, event);
  } else {
    handleToolEvent(active, event);
  }
};

export const finishTurn = (active: ActiveTurn): void => {
  active.turn.status = "completed";
  if (active.failure) {
    active.turn.status = "failed";
  }
  if (active.interrupted) {
    active.turn.status = "interrupted";
  }
  if (active.failure && !active.interrupted) {
    active.turn.error = {
      additionalDetails: null,
      codexErrorInfo: null,
      message: active.failure.message,
      misalignment: null,
    };
  }
  active.turn.completedAt = Math.floor(Date.now() / 1000);
  active.turn.durationMs = Date.now() - active.startedAtMs;
  active.connection.notify("turn/completed", {
    threadId: active.threadId,
    turn: active.turn,
  });
  active.connection.notify("thread/status/changed", {
    status: { type: "idle" },
    threadId: active.threadId,
  });
};
