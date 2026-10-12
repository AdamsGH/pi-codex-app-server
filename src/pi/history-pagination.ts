import { z } from "zod";

import type { SortDirection } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/SortDirection.js";

const cursorSchema = z.object({
  anchor: z.string(),
  direction: z.enum(["asc", "desc"]),
  scope: z.string(),
});

export const paginateHistory = <T>(
  items: readonly T[],
  options: {
    cursor?: string | null;
    direction: SortDirection;
    key: (item: T) => string;
    limit?: number | null;
    scope: string;
  }
) => {
  const ordered =
    options.direction === "desc" ? items.toReversed() : [...items];
  let offset = 0;
  if (options.cursor) {
    const cursor = cursorSchema.parse(
      JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf-8"))
    );
    const index = ordered.findIndex(
      (item) => options.key(item) === cursor.anchor
    );
    if (cursor.scope !== options.scope || index === -1) {
      throw new Error("Invalid history cursor");
    }
    offset = index + (cursor.direction === options.direction ? 1 : 0);
  }
  const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
  const data = ordered.slice(offset, offset + limit);
  const cursorFor = (item: T): string =>
    Buffer.from(
      JSON.stringify({
        anchor: options.key(item),
        direction: options.direction,
        scope: options.scope,
      })
    ).toString("base64url");
  const [first] = data;
  const last = data.at(-1);
  return {
    backwardsCursor: first ? cursorFor(first) : null,
    data,
    nextCursor:
      last && offset + data.length < ordered.length ? cursorFor(last) : null,
  };
};
