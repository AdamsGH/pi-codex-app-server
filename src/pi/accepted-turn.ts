import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import type { Turn } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/Turn.js";
import { projectPiConversation } from "./conversation-projector.js";
import { readTurnReceipts } from "./turn-receipt.js";

export const findAcceptedTurn = (options: {
  clientId: string | null | undefined;
  entries: readonly SessionEntry[];
  cwd: string;
  live?: Turn;
}): Turn | undefined => {
  if (!options.clientId) {
    return undefined;
  }
  const accepted = [...readTurnReceipts(options.entries).values()].find(
    (receipt) => receipt.clientId === options.clientId
  );
  if (!accepted) {
    if (
      options.live?.items.some(
        (item) =>
          item.type === "userMessage" && item.clientId === options.clientId
      )
    ) {
      return structuredClone(options.live);
    }
    return undefined;
  }
  // The first persisted acceptance wins even if an older client already replayed it.
  return projectPiConversation(options.entries, options.cwd).find(
    (turn) => turn.id === accepted.turnId
  );
};
