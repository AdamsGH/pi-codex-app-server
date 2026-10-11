import { readFile } from "node:fs/promises";
import path from "node:path";

import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { z } from "zod";

import type { MetadataDatabase } from "../storage/metadata-database.js";
import { PiProjectCatalog } from "./project-catalog.js";
import { readPiPresence } from "./session-presence.js";

const policySchema = z.strictObject({
  maxAgeDays: z.number().int().positive().nullable().optional(),
  mode: z.enum(["all", "active", "off"]).optional(),
});
const exportSchema = z.strictObject({
  projects: policySchema.optional(),
  unassigned: policySchema.optional(),
});
const settingsSchema = z.looseObject({
  codexAppServer: z
    .looseObject({ sessionExport: exportSchema.optional() })
    .optional(),
});

const readPolicies = async (
  file: string
): Promise<z.infer<typeof exportSchema>> => {
  try {
    return (
      settingsSchema.parse(JSON.parse(await readFile(file, "utf-8")))
        .codexAppServer?.sessionExport ?? {}
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw new Error(`Invalid Pi session export settings: ${file}`, {
      cause: error,
    });
  }
};

export class PiSessionPublication {
  readonly #agentDir: string;
  readonly #home: string;
  readonly #database: MetadataDatabase;
  readonly #working: (id: string) => boolean;
  readonly #subscriptions = new Map<AbortSignal, Set<string>>();

  constructor(options: {
    agentDir: string;
    home: string;
    database: MetadataDatabase;
    isWorking?: (id: string) => boolean;
  }) {
    this.#agentDir = options.agentDir;
    this.#home = options.home;
    this.#database = options.database;
    this.#working = options.isWorking ?? (() => false);
  }

  retain(id: string, signal: AbortSignal): void {
    if (signal.aborted) {
      return;
    }
    let ids = this.#subscriptions.get(signal);
    if (!ids) {
      ids = new Set();
      this.#subscriptions.set(signal, ids);
      signal.addEventListener(
        "abort",
        () => this.#subscriptions.delete(signal),
        { once: true }
      );
    }
    ids.add(id);
  }

  release(id: string, signal: AbortSignal): boolean {
    return this.#subscriptions.get(signal)?.delete(id) ?? false;
  }

  async assertCanStart(cwd: string): Promise<void> {
    const [global, local] = await Promise.all([
      readPolicies(path.join(this.#agentDir, "settings.json")),
      readPolicies(path.join(cwd, ".pi", "settings.json")),
    ]);
    const scope = new PiProjectCatalog(this.#database).discover(cwd)
      ? "projects"
      : "unassigned";
    if ((local[scope]?.mode ?? global[scope]?.mode ?? "all") === "off") {
      throw new Error(`Pi session publication is disabled for ${cwd}`);
    }
  }

  async select(
    sessions: readonly SessionInfo[]
  ): Promise<readonly SessionInfo[]> {
    const global = await readPolicies(
      path.join(this.#agentDir, "settings.json")
    );
    const local = new Map<string, z.infer<typeof exportSchema>>();
    await Promise.all(
      [...new Set(sessions.map(({ cwd }) => cwd))].map(async (cwd) => {
        local.set(
          cwd,
          await readPolicies(path.join(cwd, ".pi", "settings.json"))
        );
      })
    );
    const presence = await readPiPresence(this.#home);
    const now = Date.now();
    return sessions.filter((session) => {
      const scope = this.#database.getThread(session.id)?.projectId
        ? "projects"
        : "unassigned";
      const policy = {
        maxAgeDays: null,
        mode: "all",
        ...global[scope],
        ...local.get(session.cwd)?.[scope],
      };
      if (policy.mode === "off") {
        return false;
      }
      const active =
        presence.has(session.id) ||
        this.#working(session.id) ||
        [...this.#subscriptions.values()].some((ids) => ids.has(session.id));
      if (active) {
        return true;
      }
      return (
        policy.mode === "all" &&
        (policy.maxAgeDays === null ||
          session.modified.getTime() >= now - policy.maxAgeDays * 86_400_000)
      );
    });
  }
}
