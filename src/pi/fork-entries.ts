import type {
  SessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

import { projectPiConversation } from "./conversation-projector.js";

export const selectForkEntries = (
  source: SessionManager,
  lastTurnId?: string | null,
  beforeTurnId?: string | null
): SessionEntry[] => {
  if (lastTurnId && beforeTurnId) {
    throw new Error("Cannot combine lastTurnId and beforeTurnId");
  }
  const entries = source.getBranch();
  const boundary = beforeTurnId ?? lastTurnId;
  if (!boundary) {
    return entries;
  }
  const turns = projectPiConversation(entries, source.getCwd());
  const index = turns.findIndex((turn) => turn.id === boundary);
  const selected = turns[index];
  if (!selected || (!beforeTurnId && selected.status === "inProgress")) {
    throw new Error(`Cannot fork at unfinished or unknown turn: ${boundary}`);
  }
  const cutoff = beforeTurnId ? boundary : turns[index + 1]?.id;
  return cutoff
    ? entries.slice(
        0,
        entries.findIndex((entry) => entry.id === cutoff)
      )
    : entries;
};
