import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { sidebarSnapshotSchema } from "./sidebar-state.js";
import type { SidebarSnapshot } from "./sidebar-state.js";

const execute = promisify(execFile);

export const filterSidebarProjects = (
  snapshot: SidebarSnapshot,
  skipEmptyProjects: boolean
): SidebarSnapshot => {
  if (!skipEmptyProjects) {
    return snapshot;
  }
  const assigned = new Set(snapshot.threads.map((thread) => thread.projectId));
  return {
    ...snapshot,
    projects: snapshot.projects.filter((project) => assigned.has(project.id)),
  };
};

export const saveSidebarSnapshot = async (
  snapshot: SidebarSnapshot,
  file: string,
  overwrite: boolean
): Promise<void> => {
  const parsed = sidebarSnapshotSchema.parse(snapshot);
  const output = path.resolve(file);
  await mkdir(path.dirname(output), { recursive: true });
  const serialized = `${JSON.stringify(parsed, null, 2)}\n`;
  if (!overwrite) {
    await writeFile(output, serialized, { flag: "wx", mode: 0o600 });
    return;
  }
  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, serialized, { flag: "wx", mode: 0o600 });
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
};

type WslExecutor = (
  file: string,
  args: string[],
  options: {
    encoding: "utf-8";
    maxBuffer: number;
    timeout: number;
    windowsHide: boolean;
  }
) => Promise<{ stdout: string }>;

export const readWslSidebarSnapshot = async (
  options: {
    distribution: string;
    repository: string;
    skipEmptyProjects: boolean;
  },
  run: WslExecutor = execute
): Promise<SidebarSnapshot> => {
  if (!options.distribution.trim() || !options.repository.startsWith("/")) {
    throw new Error(
      "WSL export requires a distribution and an absolute Linux repository path"
    );
  }
  const args = [
    "--distribution",
    options.distribution,
    "--cd",
    options.repository,
    "--exec",
    "node",
    "dist/sidebar-sync.js",
    "export",
    "--stdout",
  ];
  const { stdout } = await run("wsl.exe", args, {
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
    windowsHide: true,
  });
  // The remote CLI must return a complete snapshot. Failed or partial exports never replace the saved candidate.
  return filterSidebarProjects(
    sidebarSnapshotSchema.parse(JSON.parse(stdout)),
    options.skipEmptyProjects
  );
};
