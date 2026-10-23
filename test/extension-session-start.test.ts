import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppDaemonController } from "../src/extension/daemon-controller.js";
import extension from "../src/extension/index.js";
import { acquireSessionLease } from "../src/pi/session-owner.js";

describe("extension attachment failure", () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0).toReversed()) {
      // eslint-disable-next-line no-await-in-loop -- Release owners before removing their temporary home.
      await close();
    }
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("keeps native input and the existing lease when another Pi owns the session", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "pi-attachment-test-"));
    cleanup.push(() => rm(home, { force: true, recursive: true }));
    vi.stubEnv("PI_CODEX_APP_SERVER_HOME", home);
    vi.stubEnv("PI_CODEX_APP_SERVER_INTERNAL", "");
    vi.stubEnv("PI_CODEX_APP_SERVER_AUTOSTART", "0");
    const manager = SessionManager.inMemory(home);
    cleanup.push(await acquireSessionLease(home, manager.getSessionId()));
    const settings = SettingsManager.inMemory({});
    let context: ExtensionContext | undefined;
    const loader = new DefaultResourceLoader({
      agentDir: home,
      cwd: home,
      extensionFactories: [
        (pi) => {
          pi.on("session_start", (_event, ctx) => {
            context = ctx;
            vi.spyOn(ctx.ui, "setStatus");
          });
        },
        extension,
      ],
      noContextFiles: true,
      noPromptTemplates: true,
      noSkills: true,
      settingsManager: settings,
    });
    await loader.reload();
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(home, "auth.json"),
      modelsPath: null,
    });
    const { session } = await createAgentSession({
      agentDir: home,
      cwd: home,
      modelRuntime,
      resourceLoader: loader,
      sessionManager: manager,
      settingsManager: settings,
      tools: [],
    });
    cleanup.push(async () => {
      await session.extensionRunner.emit({
        reason: "quit",
        type: "session_shutdown",
      });
      session.dispose();
    });
    const shutdown = vi.fn<() => void>();
    await session.bindExtensions({ mode: "tui", shutdownHandler: shutdown });
    expect(shutdown).not.toHaveBeenCalled();
    expect(context?.ui.setStatus).toHaveBeenCalledWith(
      "codex-server",
      "codex: disconnected (session in use)"
    );
    await expect(
      session.extensionRunner.emitInput(
        "native input",
        undefined,
        "interactive"
      )
    ).resolves.toMatchObject({ action: "continue" });
    await expect(
      acquireSessionLease(home, manager.getSessionId())
    ).rejects.toThrow("Lock file is already being held");
    vi.spyOn(AppDaemonController.prototype, "status").mockResolvedValue({
      endpoint: {
        pid: 4242,
        transport: "websocket",
        url: "ws://127.0.0.1:4242/",
      },
      state: "running",
    });
    const command = session.extensionRunner.getCommand("codex-server");
    if (!command) {
      throw new Error("Missing codex-server command");
    }
    await command.handler(
      "status",
      session.extensionRunner.createCommandContext()
    );
    expect(context?.ui.setStatus).toHaveBeenLastCalledWith(
      "codex-server",
      "codex: disconnected (session in use)"
    );
  });
});
