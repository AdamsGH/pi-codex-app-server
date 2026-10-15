import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { z } from "zod";

import type { Turn } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/Turn.js";
import { appServerLogger } from "../logging/app-server-logger.js";

export const TURN_RECEIPT_TYPE = "codex-app-server.turn-receipt.v1";
const identifier = z.string().min(1).max(1024);
const receiptSchema = z.strictObject({
  rootTurnId: identifier.nullable(),
  turnId: identifier,
  users: z
    .array(
      z.strictObject({
        clientId: identifier.nullable(),
        entryId: identifier,
        itemId: identifier,
      })
    )
    .min(1)
    .max(10_000),
});
type TurnReceipt = z.infer<typeof receiptSchema>;
export type UserReceipt = TurnReceipt["users"][number] &
  Pick<TurnReceipt, "turnId" | "rootTurnId">;

export const createTurnReceipt = (
  entries: readonly SessionEntry[],
  historyEntryId: string | null,
  turn: Turn
): TurnReceipt | undefined => {
  const boundary =
    historyEntryId === null
      ? -1
      : entries.findIndex((entry) => entry.id === historyEntryId);
  if (historyEntryId !== null && boundary === -1) {
    return undefined;
  }
  const persisted = entries
    .slice(boundary + 1)
    .filter(
      (entry) => entry.type === "message" && entry.message.role === "user"
    );
  const users = turn.items.filter((item) => item.type === "userMessage");
  if (persisted.length === 0 || persisted.length > users.length) {
    return undefined;
  }
  // A queued steer can be accepted without becoming a persisted Pi message.
  // Acknowledge only the ordered prefix that Pi wrote on this branch.
  return receiptSchema.parse({
    rootTurnId: turn.rootTurnId,
    turnId: turn.id,
    users: persisted.map((entry, index) => ({
      clientId: users[index]?.clientId,
      entryId: entry.id,
      itemId: users[index]?.id,
    })),
  });
};

export const readTurnReceipts = (
  entries: readonly SessionEntry[]
): ReadonlyMap<string, UserReceipt> => {
  const receipts = new Map<string, UserReceipt>();
  const users = new Set(
    entries
      .filter(
        (entry) => entry.type === "message" && entry.message.role === "user"
      )
      .map((entry) => entry.id)
  );
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== TURN_RECEIPT_TYPE) {
      continue;
    }
    const receipt = receiptSchema.safeParse(entry.data);
    if (!receipt.success) {
      continue;
    }
    for (const user of receipt.data.users) {
      if (users.has(user.entryId) && !receipts.has(user.entryId)) {
        receipts.set(user.entryId, {
          ...user,
          rootTurnId: receipt.data.rootTurnId,
          turnId: receipt.data.turnId,
        });
      }
    }
  }
  return receipts;
};

export const persistTurnReceipt = (options: {
  entries: readonly SessionEntry[];
  historyEntryId: string | null;
  turn: Turn;
  threadId: string;
  append: (type: string, data: TurnReceipt) => void;
}): void => {
  try {
    const receipt = createTurnReceipt(
      options.entries,
      options.historyEntryId,
      options.turn
    );
    if (!receipt) {
      return;
    }
    options.append(TURN_RECEIPT_TYPE, receipt);
    appServerLogger.debug("Pi turn receipt persisted", {
      acceptedUserCount: receipt.users.filter((user) => user.clientId !== null)
        .length,
      threadId: options.threadId,
      turnId: options.turn.id,
      userCount: receipt.users.length,
    });
  } catch {
    // Receipt I/O failure must not suppress the actual execution outcome.
    appServerLogger.warn(
      "Pi turn receipt was not persisted; reconcile history before retrying",
      { threadId: options.threadId, turnId: options.turn.id }
    );
  }
};
