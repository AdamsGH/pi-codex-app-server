import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import type { Socket } from "node:net";

import { z } from "zod";

import type { JsonValue } from "../protocol/validation.js";

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

interface RequestTimer {
  handle?: ReturnType<typeof setTimeout>;
}

export interface DesktopNativeTool {
  name: string;
  namespace: string;
  inputSchema?: JsonValue;
}

export interface DesktopNativeCallContext {
  threadId: string;
  turnId?: string;
  callId?: string;
}

const catalogSchema = z.object({
  tools: z.array(
    z.object({
      inputSchema: z.json().optional(),
      name: z.string().trim().min(1),
      namespace: z.string().trim().min(1),
    })
  ),
});
const resultSchema = z.object({
  contentItems: z.array(
    z.object({
      text: z.string(),
      type: z.literal("inputText"),
    })
  ),
  success: z.boolean(),
});
const responseSchema = z.union([
  z
    .object({ id: z.string(), jsonrpc: z.literal("2.0"), result: z.json() })
    .strict(),
  z
    .object({
      error: z.object({ code: z.number(), message: z.string() }),
      id: z.string(),
      jsonrpc: z.literal("2.0"),
    })
    .strict(),
]);

const frame = (value: JsonValue): Buffer => {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > MAX_FRAME_BYTES) {
    throw new Error("Desktop native tools request exceeds the frame limit");
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
};

const parseCallResult = (value: JsonValue): JsonValue => {
  const parsed = resultSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Invalid desktop native tool result");
  }
  const text = parsed.data.contentItems.map((item) => item.text);
  if (!parsed.data.success) {
    throw new Error(`Desktop native tool failed: ${text.join("\n")}`);
  }
  if (text.length !== 1) {
    throw new Error("Desktop native tool did not return one JSON result");
  }
  try {
    return z.json().parse(JSON.parse(text[0] ?? ""));
  } catch {
    throw new Error("Desktop native tool returned invalid JSON");
  }
};

export class DesktopNativeTools {
  readonly #endpoint: string;
  readonly #timeoutMs: number;
  readonly #sockets = new Set<Socket>();
  #tools: DesktopNativeTool[] | null = null;
  #closed = false;

  constructor(endpoint: string, options: { timeoutMs?: number } = {}) {
    if (!endpoint.trim()) {
      throw new Error("Desktop native tools endpoint is required");
    }
    this.#endpoint = endpoint;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new Error("Desktop native tools timeout must be positive");
    }
  }

  async listTools(): Promise<DesktopNativeTool[]> {
    const result = await this.#request("tools/list", {
      threadStartKind: "all",
    });
    const parsed = catalogSchema.safeParse(result);
    if (!parsed.success) {
      throw new Error("Invalid desktop native tools catalog");
    }
    const { tools } = parsed.data;
    if (new Set(tools.map((tool) => tool.name)).size !== tools.length) {
      throw new Error("Invalid desktop native tools catalog entry");
    }
    this.#tools = tools;
    return tools.map((tool) => ({ ...tool }));
  }

  async call(
    tool: string,
    args: JsonValue,
    context: DesktopNativeCallContext
  ): Promise<JsonValue> {
    if (!context.threadId.trim()) {
      throw new Error(
        "Desktop native tools require an actual caller thread ID"
      );
    }
    const tools = this.#tools ?? (await this.listTools());
    const definition = tools.find((entry) => entry.name === tool);
    if (!definition) {
      throw new Error(`Unknown desktop native tool: ${tool}`);
    }
    return parseCallResult(
      await this.#request("tools/call", {
        arguments: args,
        callId: context.callId ?? `mcp-call-${randomUUID()}`,
        callerSource: "codex",
        namespace: definition.namespace,
        threadId: context.threadId,
        tool,
        turnId: context.turnId ?? `mcp-turn-${randomUUID()}`,
      })
    );
  }

  close(): void {
    this.#closed = true;
    this.#tools = null;
    for (const socket of this.#sockets) {
      socket.destroy(new Error("Desktop native tools client closed"));
    }
  }

  async #request(method: string, params: JsonValue): Promise<JsonValue> {
    if (this.#closed) {
      throw new Error("Desktop native tools client is closed");
    }
    const id = randomUUID();
    const outgoing = frame({ id, jsonrpc: "2.0", method, params });
    const pending = Promise.withResolvers<JsonValue>();
    const socket = createConnection(this.#endpoint);
    this.#sockets.add(socket);
    let buffered: Buffer = Buffer.alloc(0);
    let settled = false;
    const timer: RequestTimer = {};
    const finish = (error?: Error, result: JsonValue = null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer.handle);
      this.#sockets.delete(socket);
      socket.destroy();
      if (error) {
        pending.reject(error);
      } else {
        pending.resolve(result);
      }
    };
    timer.handle = setTimeout(() => {
      if (method === "tools/call" && !socket.connecting && !socket.destroyed) {
        socket.end(frame({ id, jsonrpc: "2.0", method: "tools/cancel" }));
        // Deliver cancellation before closing; the remote mutation is never retried.
        socket.once("finish", () => socket.destroy());
        settled = true;
        this.#sockets.delete(socket);
        pending.reject(new Error("Desktop native tools request timed out"));
        return;
      }
      finish(new Error("Desktop native tools request timed out"));
    }, this.#timeoutMs);
    socket.once("connect", () => socket.write(outgoing));
    socket.on("error", (error) => finish(error));
    socket.once("close", () =>
      finish(new Error("Desktop native tools connection closed"))
    );
    socket.on("data", (chunk: Buffer) => {
      if (settled) {
        return;
      }
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 4) {
        return;
      }
      const size = buffered.readUInt32LE(0);
      if (size === 0 || size > MAX_FRAME_BYTES || buffered.length > size + 4) {
        finish(new Error("Invalid desktop native tools response frame"));
        return;
      }
      if (buffered.length < size + 4) {
        return;
      }
      let response: z.infer<typeof responseSchema>;
      try {
        response = responseSchema.parse(
          JSON.parse(buffered.subarray(4).toString("utf-8"))
        );
      } catch {
        finish(
          new Error("Invalid desktop native tools response JSON or envelope")
        );
        return;
      }
      if (response.id !== id) {
        finish(new Error("Invalid desktop native tools response ID"));
        return;
      }
      if ("error" in response) {
        finish(new Error(response.error.message));
        return;
      }
      finish(undefined, response.result);
    });
    return await pending.promise;
  }
}
