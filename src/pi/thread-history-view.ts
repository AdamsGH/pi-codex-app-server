import type { Thread } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/Thread.js";
import type { ThreadResumeParams } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/ThreadResumeParams.js";
import type { ThreadTurnsListParams } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/ThreadTurnsListParams.js";
import type { Turn } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/Turn.js";
import type { TurnItemsView } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/TurnItemsView.js";
import { paginateHistory } from "./history-pagination.js";

const withItemsView = (turn: Turn, view: TurnItemsView): Turn => {
  if (view === "full") {
    return { ...turn, itemsView: view };
  }
  if (view === "notLoaded") {
    return { ...turn, items: [], itemsView: view };
  }
  const firstUser = turn.items.find((item) => item.type === "userMessage");
  const lastAgent = turn.items.findLast((item) => item.type === "agentMessage");
  return {
    ...turn,
    items: [firstUser, lastAgent].filter((item) => item !== undefined),
    itemsView: view,
  };
};

export const pageThreadTurns = (
  thread: Thread,
  params: ThreadTurnsListParams
) => {
  const page = paginateHistory(thread.turns, {
    cursor: params.cursor,
    direction: params.sortDirection ?? "desc",
    key: (turn) => turn.id,
    limit: params.limit,
    scope: `turns:${thread.id}`,
  });
  return {
    ...page,
    data: page.data.map((turn) =>
      withItemsView(turn, params.itemsView ?? "summary")
    ),
  };
};

export const resumeThreadHistory = (
  thread: Thread,
  params: ThreadResumeParams
) => ({
  initialTurnsPage: params.initialTurnsPage
    ? pageThreadTurns(thread, {
        threadId: thread.id,
        ...params.initialTurnsPage,
      })
    : null,
  itemsBackwardsCursor: null,
  thread: params.excludeTurns ? { ...thread, turns: [] } : thread,
  turnsBackwardsCursor: null,
});
