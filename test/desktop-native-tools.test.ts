import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { DesktopNativeTools } from "../src/desktop/native-tools.js";
import type { JsonValue } from "../src/protocol/validation.js";

interface Request {
  id: string;
  method: string;
  params?: Record<string, JsonValue>;
}

const encode = (value: JsonValue): Buffer => {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
};

const fixture = async (handle: (request: Request, socket: Socket) => void) => {
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\pi-desktop-test-${randomUUID()}`
      : path.join(tmpdir(), `pi-desktop-test-${randomUUID()}.sock`);
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffered: Buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4) {
        const size = buffered.readUInt32LE(0);
        if (buffered.length < size + 4) {
          return;
        }
        // SAFETY: The test fixture receives only requests encoded by the client under test.
        const request = JSON.parse(
          buffered.subarray(4, size + 4).toString()
        ) as Request;
        buffered = buffered.subarray(size + 4);
        handle(request, socket);
      }
    });
  });
  const ready = Promise.withResolvers<undefined>();
  server.listen(endpoint, () => ready.resolve());
  server.once("error", ready.reject);
  await ready.promise;
  return {
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      const closed = Promise.withResolvers<undefined>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
    endpoint,
  };
};

const catalog = {
  tools: [
    { inputSchema: { type: "object" }, name: "move", namespace: "codex_app" },
  ],
};
const reply = (request: Request, socket: Socket, result: JsonValue): void => {
  socket.write(encode({ id: request.id, jsonrpc: "2.0", result }));
};

describe("Desktop native tools", () => {
  test("discovers namespace, correlates fragmented responses, and preserves actual caller", async () => {
    const calls: Request[] = [];
    const host = await fixture((request, socket) => {
      calls.push(request);
      const response = encode({
        id: request.id,
        jsonrpc: "2.0",
        result:
          request.method === "tools/list"
            ? catalog
            : {
                contentItems: [{ text: '{"moved":true}', type: "inputText" }],
                success: true,
              },
      });
      socket.write(response.subarray(0, 2));
      setImmediate(() => socket.write(response.subarray(2, 7)));
      setImmediate(() => socket.write(response.subarray(7)));
    });
    const client = new DesktopNativeTools(host.endpoint);
    try {
      await expect(
        client.call(
          "move",
          { target: "native-target" },
          {
            callId: "actual-call",
            threadId: "native-caller",
            turnId: "actual-turn",
          }
        )
      ).resolves.toStrictEqual({ moved: true });
      expect(calls[1]?.params).toStrictEqual({
        arguments: { target: "native-target" },
        callId: "actual-call",
        callerSource: "codex",
        namespace: "codex_app",
        threadId: "native-caller",
        tool: "move",
        turnId: "actual-turn",
      });
      await expect(
        client.call("missing", {}, { threadId: "native-caller" })
      ).rejects.toThrow("Unknown");
      await expect(client.call("move", {}, { threadId: " " })).rejects.toThrow(
        "actual caller"
      );
      expect(calls).toHaveLength(2);
    } finally {
      client.close();
      await host.close();
    }
  });

  test("cancels a timed-out call by matching ID and never replays the mutation", async () => {
    const requests: Request[] = [];
    const cancelled = Promise.withResolvers<Request>();
    const host = await fixture((request, socket) => {
      requests.push(request);
      if (request.method === "tools/list") {
        reply(request, socket, catalog);
      }
      if (request.method === "tools/cancel") {
        cancelled.resolve(request);
      }
    });
    const client = new DesktopNativeTools(host.endpoint, { timeoutMs: 50 });
    try {
      await expect(
        client.call("move", {}, { threadId: "native-caller" })
      ).rejects.toThrow("timed out");
      const cancellation = await cancelled.promise;
      expect(cancellation.id).toBe(
        requests.find((request) => request.method === "tools/call")?.id
      );
      expect(
        requests.filter((request) => request.method === "tools/call")
      ).toHaveLength(1);
    } finally {
      client.close();
      await host.close();
    }
  });

  test.each(["oversized", "wrong-id", "invalid-json", "invalid-envelope"])(
    "rejects %s native responses",
    async (kind) => {
      const host = await fixture((request, socket) => {
        if (kind === "oversized") {
          const header = Buffer.alloc(4);
          header.writeUInt32LE(8 * 1024 * 1024 + 1);
          socket.write(header);
        } else if (kind === "invalid-json") {
          socket.write(Buffer.from([1, 0, 0, 0, 123]));
        } else {
          socket.write(
            encode({
              id: kind === "wrong-id" ? "another" : request.id,
              jsonrpc: kind === "invalid-envelope" ? "1.0" : "2.0",
              result: catalog,
            })
          );
        }
      });
      const client = new DesktopNativeTools(host.endpoint);
      try {
        await expect(client.listTools()).rejects.toThrow("Invalid");
      } finally {
        client.close();
        await host.close();
      }
    }
  );

  test("close rejects pending requests and prevents new connections", async () => {
    const received = Promise.withResolvers<undefined>();
    const host = await fixture(() => received.resolve());
    const client = new DesktopNativeTools(host.endpoint);
    try {
      const pending = client.listTools();
      const captureFailure = async (): Promise<Error> => {
        try {
          await pending;
          throw new Error("Expected closed client failure");
        } catch (error) {
          if (error instanceof Error) {
            return error;
          }
          throw error;
        }
      };
      const captured = captureFailure();
      await received.promise;
      client.close();
      await expect(captured).resolves.toMatchObject({
        message: "Desktop native tools client closed",
      });
      await expect(client.listTools()).rejects.toThrow("closed");
    } finally {
      client.close();
      await host.close();
    }
  });

  test("propagates native failure without retry", async () => {
    const host = await fixture((request, socket) =>
      reply(
        request,
        socket,
        request.method === "tools/list"
          ? catalog
          : {
              contentItems: [
                { text: "permission rejected", type: "inputText" },
              ],
              success: false,
            }
      )
    );
    const client = new DesktopNativeTools(host.endpoint);
    try {
      await expect(
        client.call("move", {}, { threadId: "native-caller" })
      ).rejects.toThrow("permission rejected");
    } finally {
      client.close();
      await host.close();
    }
  });
});
