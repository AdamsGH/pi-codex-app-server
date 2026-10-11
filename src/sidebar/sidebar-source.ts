import { once } from "node:events";
import { readFile } from "node:fs/promises";

import { JSONRPCClient } from "json-rpc-2.0";
import { WebSocket } from "ws";
import { z } from "zod";

import {
  sidebarSnapshotSchema,
  sidebarSnapshotThreadSchema,
} from "./sidebar-state.js";
import type { SidebarSnapshot } from "./sidebar-state.js";

const envelopeSchema = z.object({
  error: z
    .object({ code: z.number().default(-32_000), message: z.string() })
    .optional(),
  id: z.number().optional(),
  result: z.json().optional(),
});
const pageSchema = z.object({
  data: z.array(z.json()),
  nextCursor: z.string().nullable(),
});
type PageItem = z.infer<typeof pageSchema>["data"][number];

export const readSidebarSnapshot = async (
  endpoint: string
): Promise<SidebarSnapshot> => {
  const url =
    endpoint.startsWith("ws://") || endpoint.startsWith("wss://")
      ? endpoint
      : z
          .object({ url: z.url() })
          .parse(JSON.parse(await readFile(endpoint, "utf-8"))).url;
  const socket = new WebSocket(url, {
    handshakeTimeout: 10_000,
    maxPayload: 16 * 1024 * 1024,
  });
  const client = new JSONRPCClient((payload) => {
    socket.send(JSON.stringify(payload));
  });
  socket.on("message", (raw) => {
    try {
      const message = envelopeSchema.parse(JSON.parse(raw.toString()));
      if (message.id === undefined) {
        return;
      }
      if (message.error) {
        client.receive({
          error: message.error,
          id: message.id,
          jsonrpc: "2.0",
        });
      } else {
        client.receive({
          id: message.id,
          jsonrpc: "2.0",
          result: message.result,
        });
      }
    } catch (error) {
      client.rejectAllPendingRequests(
        error instanceof Error ? error.message : "Invalid app-server response"
      );
    }
  });
  socket.on("error", (error) => client.rejectAllPendingRequests(error.message));
  socket.on("close", () =>
    client.rejectAllPendingRequests("App-server connection closed")
  );
  const requester = client.timeout(30_000);
  try {
    await once(socket, "open");
    const initialized = z.object({ codexHome: z.string() }).parse(
      await requester.request("initialize", {
        capabilities: { experimentalApi: true },
        clientInfo: { name: "pi-sidebar-sync", version: "1" },
      })
    );
    const pages = async (
      method: string,
      extra: { archived?: boolean } = {}
    ): Promise<PageItem[]> => {
      const data: PageItem[] = [];
      const cursors = new Set<string>();
      let cursor: string | null = null;
      do {
        // Each page depends on the cursor returned by the previous request.
        // oxlint-disable-next-line no-await-in-loop
        const response = await requester.request(method, {
          ...extra,
          cursor,
          limit: 500,
        });
        const page = pageSchema.parse(response);
        data.push(...page.data);
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) {
          throw new Error(`${method}: repeated pagination cursor`);
        }
        if (cursor) {
          cursors.add(cursor);
        }
      } while (cursor);
      return data;
    };
    const projects = await pages("project/list");
    const sections = z
      .array(z.object({ id: z.string(), name: z.string() }))
      .parse(await pages("threadSection/list"));
    const active = await pages("thread/list", { archived: false });
    const archived = await pages("thread/list", { archived: true });
    const threadMap = new Map(
      [
        ...active.map((thread) =>
          sidebarSnapshotThreadSchema.parse({
            ...z.record(z.string(), z.json()).parse(thread),
            archived: false,
          })
        ),
        ...archived.map((thread) =>
          sidebarSnapshotThreadSchema.parse({
            ...z.record(z.string(), z.json()).parse(thread),
            archived: true,
          })
        ),
      ].map((thread) => [thread.id, thread])
    );
    const threads = [...threadMap.values()];
    return sidebarSnapshotSchema.parse({
      projects,
      schemaVersion: 1,
      sectionId: sections.find(({ name }) => name === "Pi")?.id ?? null,
      sourceHome: initialized.codexHome,
      threads,
    });
  } finally {
    socket.terminate();
  }
};
