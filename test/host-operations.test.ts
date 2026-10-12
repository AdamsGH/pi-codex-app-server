import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import { appServerLogger } from "../src/logging/app-server-logger.js";
import { JsonRpcConnection } from "../src/protocol/json-rpc-connection.js";
import { parseCodexWireMessage } from "../src/protocol/validation.js";
import { registerHostOperations } from "../src/server/host-operations.js";
import { AsyncMessageQueue } from "../src/transports/async-message-queue.js";

describe("Host processes", () => {
  test.each([false, true])(
    "delivers process completion and capped output with streaming=%s",
    async (streaming) => {
      const queue = new AsyncMessageQueue();
      const messages: ReturnType<typeof parseCodexWireMessage>[] = [];
      const connection = new JsonRpcConnection({
        clientId: "host-test",
        logger: appServerLogger,
        transport: {
          close: () => queue.close(),
          read: () => queue,
          send: (message) => {
            messages.push(parseCodexWireMessage(message));
            return Promise.resolve();
          },
        },
      });
      connection.registerCompatibilityFallbacks();
      connection.registerRequest("initialize", () => ({
        codexHome: process.cwd(),
        platformFamily: "windows",
        platformOs: "windows",
        userAgent: "test",
      }));
      registerHostOperations(connection);
      const run = connection.run();
      const requests = [
        {
          id: 1,
          method: "initialize",
          params: { clientInfo: { name: "host-test", version: "1" } },
        },
        {
          id: 2,
          method: "process/spawn",
          params: {
            command: [
              process.execPath,
              "-e",
              "process.stdout.write('abcdef');process.stderr.write('oops');process.exitCode=7",
            ],
            cwd: process.cwd(),
            outputBytesCap: 3,
            processHandle: "probe",
            streamStdoutStderr: streaming,
          },
        },
        {
          id: 3,
          method: "fs/getMetadata",
          params: { path: path.join(process.cwd(), "package.json") },
        },
      ];
      for (const request of requests) {
        queue.push(JSON.stringify(request));
      }
      try {
        await vi.waitFor(() =>
          expect(messages).toContainEqual({
            method: "process/exited",
            params: {
              exitCode: 7,
              processHandle: "probe",
              stderr: streaming ? "" : "oop",
              stderrCapReached: true,
              stdout: streaming ? "" : "abc",
              stdoutCapReached: true,
            },
          })
        );
        expect(messages).toContainEqual({ id: 2, result: {} });
        expect(messages).toContainEqual(
          expect.objectContaining({
            id: 3,
            result: expect.objectContaining({
              isDirectory: false,
              isFile: true,
            }),
          })
        );
        expect(
          messages.filter(
            (message) =>
              "method" in message && message.method === "process/outputDelta"
          )
        ).toHaveLength(streaming ? 2 : 0);
      } finally {
        connection.close();
        await run;
      }
    }
  );
});
