import { once } from "node:events";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";
import { WebSocketServer } from "ws";
import { z } from "zod";

import { desktopProcessPattern } from "../src/sidebar/desktop-processes.js";
import { readSidebarSnapshot } from "../src/sidebar/sidebar-source.js";

type FixtureResult =
  | { codexHome: string }
  | {
      data: {
        id: string;
        name?: string;
        roots?: { path: string }[];
        projectId?: string | null;
        preview?: string;
      }[];
      nextCursor: string | null;
    };

const requestSchema = z.object({
  id: z.number(),
  method: z.string(),
  params: z
    .object({
      archived: z.boolean().optional(),
      cursor: z.string().nullable().optional(),
    })
    .optional(),
});

describe("Sidebar source", () => {
  test("reports how to recover a stale daemon endpoint", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = z.object({ port: z.number() }).parse(server.address());
    await promisify(server.close.bind(server))();
    await expect(
      readSidebarSnapshot(`ws://127.0.0.1:${address.port}`)
    ).rejects.toThrow("just daemon");
  });

  test("initializes and follows project and active/archived thread pagination", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const requests: string[] = [];
    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const request = requestSchema.parse(JSON.parse(raw.toString()));
        requests.push(request.method);
        let result: FixtureResult = { data: [], nextCursor: null };
        if (request.method === "initialize") {
          result = { codexHome: "/pi" };
        }
        if (request.method === "project/list") {
          result = request.params?.cursor
            ? {
                data: [
                  { id: "p2", name: "Second", roots: [{ path: "/second" }] },
                ],
                nextCursor: null,
              }
            : {
                data: [
                  { id: "p1", name: "First", roots: [{ path: "/first" }] },
                ],
                nextCursor: "next",
              };
        }
        if (request.method === "threadSection/list") {
          result = { data: [{ id: "s", name: "Pi" }], nextCursor: null };
        }
        if (request.method === "thread/list") {
          result = {
            data: [
              {
                id: request.params?.archived ? "archived" : "active",
                preview: "Must not export conversation text",
                projectId: request.params?.archived ? null : "p1",
              },
            ],
            nextCursor: null,
          };
        }
        socket.send(JSON.stringify({ id: request.id, result }));
      });
    });
    await once(server, "listening");
    try {
      const address = z.object({ port: z.number() }).parse(server.address());
      const snapshot = await readSidebarSnapshot(
        `ws://127.0.0.1:${address.port}`
      );
      expect(snapshot).toMatchObject({
        projects: [{ id: "p1" }, { id: "p2" }],
        sectionId: "s",
        threads: [
          { archived: false, id: "active", projectId: "p1" },
          { archived: true, id: "archived", projectId: null },
        ],
      });
      expect(JSON.stringify(snapshot)).not.toContain("Must not export");
      expect(requests).toStrictEqual([
        "initialize",
        "project/list",
        "project/list",
        "threadSection/list",
        "thread/list",
        "thread/list",
      ]);
    } finally {
      for (const client of server.clients) {
        client.terminate();
      }
      await promisify(server.close.bind(server))();
    }
  });

  test("rejects repeated cursors instead of exporting an incomplete or endless snapshot", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const request = requestSchema.parse(JSON.parse(raw.toString()));
        socket.send(
          JSON.stringify({
            id: request.id,
            result:
              request.method === "initialize"
                ? { codexHome: "/pi" }
                : { data: [], nextCursor: "repeat" },
          })
        );
      });
    });
    await once(server, "listening");
    try {
      const address = z.object({ port: z.number() }).parse(server.address());
      await expect(
        readSidebarSnapshot(`ws://127.0.0.1:${address.port}`)
      ).rejects.toThrow("repeated pagination cursor");
    } finally {
      for (const client of server.clients) {
        client.terminate();
      }
      await promisify(server.close.bind(server))();
    }
  });

  test.each([
    [
      "C:\\Program Files\\WindowsApps\\OpenAI.Codex_29.1_x64\\app\\ChatGPT.exe",
      true,
    ],
    ["/Applications/Codex.app/Contents/MacOS/Codex", true],
    ["/opt/Codex/codex --type=renderer", true],
    ["/usr/bin/codex-desktop", true],
    ["/home/user/.codex/bin/codex app-server", false],
    ["C:\\Users\\user\\.codex\\bin\\codex.exe app-server", false],
  ])(
    "recognizes desktop processes without treating the CLI as the desktop: %s",
    (command, expected) => {
      expect(desktopProcessPattern.test(command)).toBe(expected);
    }
  );
});
