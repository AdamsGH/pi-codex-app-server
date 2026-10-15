import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";

import { projectPiConversation } from "../src/pi/conversation-projector.js";
import { emptyTurn } from "../src/pi/live-turn.js";
import {
  createTurnReceipt,
  persistTurnReceipt,
  readTurnReceipts,
  TURN_RECEIPT_TYPE,
} from "../src/pi/turn-receipt.js";

const fixture = () => {
  const session = SessionManager.inMemory("/synthetic");
  const boundary = session.appendMessage({
    content: "older input",
    role: "user",
    timestamp: 1,
  });
  const entryId = session.appendMessage({
    content: "private input",
    role: "user",
    timestamp: 2,
  });
  const turn = emptyTurn();
  turn.items.push(
    {
      clientId: "accepted",
      content: [],
      id: "accepted-item",
      type: "userMessage",
    },
    { clientId: "queued", content: [], id: "queued-item", type: "userMessage" }
  );
  return { boundary, entryId, session, turn };
};

describe("persisted turn receipts", () => {
  test("acknowledges persisted messages without claiming an unconsumed steer or an older turn", () => {
    const f = fixture();
    const receipt = createTurnReceipt(
      f.session.getBranch(),
      f.boundary,
      f.turn
    );
    expect(receipt?.users).toStrictEqual([
      { clientId: "accepted", entryId: f.entryId, itemId: "accepted-item" },
    ]);
    expect(JSON.stringify(receipt)).not.toContain("private input");
    expect(
      createTurnReceipt(f.session.getBranch(), "missing-boundary", f.turn)
    ).toBeUndefined();
  });

  test("keeps consumed steering messages in the original live turn", () => {
    const f = fixture();
    f.session.appendMessage({
      content: "steered input",
      role: "user",
      timestamp: 3,
    });
    const receipt = createTurnReceipt(
      f.session.getBranch(),
      f.boundary,
      f.turn
    );
    f.session.appendCustomEntry(TURN_RECEIPT_TYPE, receipt);
    const turns = projectPiConversation(f.session.getBranch(), "/synthetic");
    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({
      id: f.turn.id,
      items: [
        { clientId: "accepted", id: "accepted-item" },
        { clientId: "queued", id: "queued-item" },
      ],
    });
  });

  test("ignores malformed receipts and references outside the selected branch", () => {
    const f = fixture();
    const receipt = createTurnReceipt(
      f.session.getBranch(),
      f.boundary,
      f.turn
    );
    f.session.appendCustomEntry(TURN_RECEIPT_TYPE, { ...receipt, turnId: 42 });
    expect(readTurnReceipts(f.session.getBranch()).size).toBe(0);
    f.session.appendCustomEntry(TURN_RECEIPT_TYPE, receipt);
    const branch = f.session
      .getBranch()
      .filter((entry) => entry.id !== f.entryId);
    expect(readTurnReceipts(branch).size).toBe(0);
  });

  test("does not suppress execution completion when receipt storage fails", () => {
    const f = fixture();
    const append = vi.fn<() => void>(() => {
      throw new Error("Synthetic write failure");
    });
    expect(() =>
      persistTurnReceipt({
        append,
        entries: f.session.getBranch(),
        historyEntryId: f.boundary,
        threadId: "thread",
        turn: f.turn,
      })
    ).not.toThrow();
    expect(append).toHaveBeenCalledOnce();
  });
});
