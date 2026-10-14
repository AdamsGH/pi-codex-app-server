import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import type { AppServerConfig } from "../config/app-server-config.js";
import { appServerLogger } from "../logging/app-server-logger.js";

const settingsSchema = z.object({
  callerThreadId: z.string().trim().min(1),
  enabled: z.boolean(),
  hostId: z.string().trim().min(1),
  sectionId: z.string().trim().min(1),
});

export const startManagedDesktopSync = async (
  config: AppServerConfig
): Promise<() => boolean> => {
  let settings;
  try {
    settings = settingsSchema.parse(
      JSON.parse(
        await readFile(
          path.join(config.paths.home, "desktop-sync.json"),
          "utf-8"
        )
      )
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return () => false;
    }
    throw new Error("Invalid desktop-sync.json configuration", {
      cause: error,
    });
  }
  if (!settings.enabled) {
    return () => false;
  }
  const script = fileURLToPath(new URL("desktop-sync.js", import.meta.url));
  const args = [
    script,
    "--host-id",
    settings.hostId,
    "--section-id",
    settings.sectionId,
    "--caller-thread-id",
    settings.callerThreadId,
    "--endpoint",
    config.paths.endpoint,
    "--sources",
    path.join(config.paths.home, "desktop-sync.json"),
  ];
  let closed = false;
  let child: ChildProcess | undefined;
  let restart: ReturnType<typeof setTimeout> | undefined;
  const launch = (): void => {
    if (closed) {
      return;
    }
    child = spawn(process.execPath, args, {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      windowsHide: true,
    });
    child.on("error", (error) => appServerLogger.warn(error));
    child.once("exit", () => {
      if (!closed) {
        restart = setTimeout(launch, 5000);
      }
    });
  };
  launch();
  return () => {
    closed = true;
    clearTimeout(restart);
    child?.kill();
    return true;
  };
};
