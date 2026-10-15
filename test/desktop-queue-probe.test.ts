import { runInNewContext } from "node:vm";

import { describe, expect, test } from "vitest";

import { collectDesktopQueueState } from "../scripts/desktop-queue-probe.mjs";

describe("desktop queue probe", () => {
  test("reports pending turn identities without conversation content or credentials", async () => {
    const manager = {
      getConversation: () => ({
        resumeState: "resumed",
        threadRuntimeStatus: { type: "idle" },
        turns: [
          {
            items: [
              {
                clientId: "client",
                content: "private prompt",
                id: "user",
                type: "userMessage",
              },
              {
                arguments: { token: "private token" },
                type: "dynamicToolCall",
              },
            ],
            params: {
              clientUserMessageId: "client",
              input: [{ text: "private prompt" }],
            },
            status: "inProgress",
            turnId: null,
          },
        ],
      }),
      getStreamRole: () => ({ role: "owner" }),
    };
    const store = {
      get: () => ({ forHost: () => manager }),
      set: () => {
        throw new Error("Unexpected mutation");
      },
    };
    const probe: typeof collectDesktopQueueState = runInNewContext(
      `(${collectDesktopQueueState.toString()})`,
      { clearTimeout, setTimeout }
    );
    const report = await probe(
      { hostId: "host", threadId: "thread" },
      {
        document: {
          querySelectorAll: () => [
            { __reactFiber$test: { memoizedProps: { value: store } } },
          ],
        },
        loadModule: () => ({ v$t: "registry" }),
        performance: {
          getEntriesByType: () => [
            { name: "app://desktop/assets/app-shared-30671c57ec82.js" },
          ],
        },
      }
    );
    expect(report.turns).toMatchObject([
      { clientUserMessageId: "client", status: "inProgress", turnId: null },
    ]);
    expect(JSON.stringify(report)).not.toContain("private");
  });
});
