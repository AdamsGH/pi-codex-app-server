import { describe, expect, test } from "vitest";

import { paginateHistory } from "../src/pi/history-pagination.js";

describe("History pagination", () => {
  test("starts exclusively from an item anchor in either direction and continues with an opaque cursor", () => {
    const items = ["one", "two", "three", "four"];
    const options = { key: (item: string) => item, limit: 1, scope: "turn" };
    const page = paginateHistory(items, {
      ...options,
      anchor: "two",
      direction: "asc",
    });
    expect(page.data).toStrictEqual(["three"]);
    expect(
      paginateHistory(items, {
        ...options,
        cursor: page.nextCursor,
        direction: "asc",
      }).data
    ).toStrictEqual(["four"]);
    expect(
      paginateHistory(items, { ...options, anchor: "three", direction: "desc" })
        .data
    ).toStrictEqual(["two"]);
    expect(() =>
      paginateHistory(items, {
        ...options,
        anchor: "missing",
        direction: "asc",
      })
    ).toThrow("History anchor not found");
  });

  test("continues from a stable anchor after a newer turn arrives and reverses direction inclusively", () => {
    const items = ["one", "two", "three", "four"];
    const options = {
      direction: "desc" as const,
      key: (item: string) => item,
      limit: 2,
      scope: "thread",
    };
    const first = paginateHistory(items, options);
    expect(first.data).toStrictEqual(["four", "three"]);
    const next = paginateHistory([...items, "five"], {
      ...options,
      cursor: first.nextCursor,
    });
    expect(next.data).toStrictEqual(["two", "one"]);
    expect(next.nextCursor).toBeNull();
    expect(
      paginateHistory(items, {
        ...options,
        cursor: next.backwardsCursor,
        direction: "asc",
      }).data
    ).toStrictEqual(["two", "three"]);
    expect(() =>
      paginateHistory(items, {
        ...options,
        cursor: first.nextCursor,
        scope: "other-thread",
      })
    ).toThrow("Invalid history cursor");
  });
});
