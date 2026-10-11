import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import type { AppServerConfig } from "../src/config/app-server-config.js";
import { AppDaemonController } from "../src/extension/daemon-controller.js";

describe("daemon controller", () => {
  test("concurrent controllers sharing a home launch only one daemon", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "pi-daemon-start-"));
    const config: AppServerConfig = {
      autoStart: false,
      hostName: "test",
      listenUrl: new URL("ws://127.0.0.1:0"),
      paths: {
        database: path.join(home, "state.sqlite"),
        endpoint: path.join(home, "endpoint.json"),
        home,
        logs: path.join(home, "logs"),
      },
      piAgentDir: home,
      remoteControl: {
        baseUrl: new URL("https://chatgpt.com/backend-api/"),
        enabled: false,
      },
    };
    const failures: ((failure: Error) => void)[] = [];
    type LaunchDaemon = NonNullable<
      ConstructorParameters<typeof AppDaemonController>[1]
    >;
    const launch = vi.fn<LaunchDaemon>(() => {
      const { promise, resolve } = Promise.withResolvers<Error>();
      failures.push(resolve);
      writeFileSync(
        config.paths.endpoint,
        JSON.stringify({
          pid: process.pid,
          transport: "websocket",
          url: "ws://127.0.0.1:12345/",
        })
      );
      return {
        failure: promise,
        pid: process.pid,
      };
    });
    try {
      const controllers = Array.from(
        { length: 3 },
        () => new AppDaemonController(config, launch)
      );
      const statuses = await Promise.all(
        controllers.map((controller) => controller.start())
      );
      expect(launch).toHaveBeenCalledOnce();
      expect(statuses).toStrictEqual(
        Array.from({ length: 3 }, () => ({
          endpoint: {
            pid: process.pid,
            transport: "websocket",
            url: "ws://127.0.0.1:12345/",
          },
          state: "running",
        }))
      );
    } finally {
      for (const resolve of failures) {
        resolve(new Error("Synthetic daemon stopped"));
      }
      await rm(home, { force: true, recursive: true });
    }
  });
});
