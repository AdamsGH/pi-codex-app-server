import { describe, expect, test } from "vitest";

import { emptyTurn } from "../src/pi/live-turn.js";
import {
  migrateOwnerNotification,
  migrateOwnerTurn,
} from "../src/pi/owner-protocol-migration.js";
import {
  ProtocolValidationError,
  parseCodexWireMessage,
  parseServerNotification,
} from "../src/protocol/validation.js";
import type { JsonValue } from "../src/protocol/validation.js";

const legacyTurn = () => {
  const { rootTurnId: _root, ...turn } = emptyTurn();
  return {
    ...turn,
    error: {
      additionalDetails: null,
      codexErrorInfo: null,
      message: "failure",
    },
    items: [
      {
        delivery: null,
        id: "answer",
        memoryCitation: null,
        phase: null,
        text: "streamed text",
        type: "agentMessage",
      },
    ],
  };
};
const parseTurn = (turn: JsonValue) =>
  parseServerNotification(
    parseCodexWireMessage(
      JSON.stringify({
        method: "turn/started",
        params: { threadId: "thread", turn },
      })
    )
  );

describe("Pi owner protocol migration", () => {
  test("upgrades legacy snapshots and turn results before strict public validation", () => {
    const original = legacyTurn();
    const migrated = migrateOwnerTurn(original, 1);
    expect(() => parseTurn(migrated)).not.toThrow();
    expect(original).not.toHaveProperty("rootTurnId");
    expect(migrated).toMatchObject({
      error: { misalignment: null },
      items: [{ questions: null, text: "streamed text" }],
      rootTurnId: null,
    });
    expect(migrateOwnerTurn(original, 2)).toBe(original);
    expect(() =>
      parseTurn(migrateOwnerTurn({ ...original, rootTurnId: 42 }, 1))
    ).toThrow(ProtocolValidationError);
  });

  test("upgrades streamed legacy items, errors, and completed turns", () => {
    const turn = legacyTurn();
    const notifications: JsonValue[] = [
      { method: "turn/completed", params: { threadId: "thread", turn } },
      {
        method: "item/completed",
        params: {
          completedAtMs: 1,
          item: Array.isArray(turn.items) ? (turn.items[0] ?? null) : null,
          threadId: "thread",
          turnId: "turn",
        },
      },
      {
        method: "error",
        params: {
          error: turn.error ?? null,
          threadId: "thread",
          turnId: "turn",
          willRetry: false,
        },
      },
    ];
    for (const notification of notifications) {
      expect(() =>
        parseServerNotification(
          parseCodexWireMessage(
            JSON.stringify(migrateOwnerNotification(notification, 1))
          )
        )
      ).not.toThrow();
    }
  });
});
