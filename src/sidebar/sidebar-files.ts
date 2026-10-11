import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { lock } from "proper-lockfile";

import { assertDesktopStopped } from "./desktop-processes.js";
import { sidebarStateSchema } from "./sidebar-state.js";
import type { SidebarState } from "./sidebar-state.js";

const fingerprint = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export const parseSidebarFile = (contents: string): SidebarState =>
  sidebarStateSchema.parse(JSON.parse(contents));

export interface DesktopProcessGuard {
  assertStopped: () => Promise<void>;
}

const desktopProcessGuard: DesktopProcessGuard = {
  assertStopped: assertDesktopStopped,
};

export const replaceSidebarFile = async (
  statePath: string,
  original: string,
  updated: SidebarState,
  processGuard: DesktopProcessGuard = desktopProcessGuard
): Promise<string> => {
  const release = await lock(statePath, { realpath: false, retries: 0 });
  const temporary = path.join(
    path.dirname(statePath),
    `.${path.basename(statePath)}.${randomUUID()}.tmp`
  );
  try {
    await processGuard.assertStopped();
    const current = await readFile(statePath, "utf-8");
    if (fingerprint(current) !== fingerprint(original)) {
      throw new Error(
        "Codex state changed after planning. Run the command again."
      );
    }
    const backup = `${statePath}.sidebar-backup-${Date.now()}-${randomUUID()}`;
    await copyFile(statePath, backup, constants.COPYFILE_EXCL);
    await chmod(backup, 0o600);
    const serialized = `${JSON.stringify(updated, null, 2)}\n`;
    await writeFile(temporary, serialized, { flag: "wx", mode: 0o600 });
    await processGuard.assertStopped();
    if (
      fingerprint(await readFile(statePath, "utf-8")) !== fingerprint(original)
    ) {
      throw new Error(
        "Codex state changed before replacement. No changes applied."
      );
    }
    await rename(temporary, statePath);
    if ((await readFile(statePath, "utf-8")) !== serialized) {
      throw new Error(`Sidebar verification failed. Backup: ${backup}`);
    }
    return backup;
  } finally {
    await Promise.all([rm(temporary, { force: true }), release()]);
  }
};
