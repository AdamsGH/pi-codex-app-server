import { rm } from "node:fs/promises";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";

import type { MetadataDatabase } from "../storage/metadata-database.js";
import { PiProjectCatalog } from "./project-catalog.js";

export class PiSessionRepository {
  readonly projects: PiProjectCatalog;
  readonly #database: MetadataDatabase;

  constructor(database: MetadataDatabase) {
    this.#database = database;
    this.projects = new PiProjectCatalog(database);
  }

  async list(): Promise<readonly SessionInfo[]> {
    const sessions = await SessionManager.listAll();
    for (const session of sessions) {
      const stored = this.#database.getThread(session.id);
      this.#database.upsertThread({
        archived: stored?.archived ?? false,
        projectId: this.projects.isAssigned(session.id)
          ? (stored?.projectId ?? null)
          : (stored?.projectId ?? this.projects.discover(session.cwd)),
        sessionFile: session.path,
        threadId: session.id,
        updatedAt: session.modified.getTime(),
      });
    }
    return sessions;
  }

  async load(threadId: string): Promise<SessionManager | undefined> {
    let thread = this.#database.getThread(threadId);
    if (!thread) {
      await this.list();
      thread = this.#database.getThread(threadId);
    }
    return thread ? SessionManager.open(thread.sessionFile) : undefined;
  }

  async delete(threadId: string): Promise<boolean> {
    const thread = this.#database.getThread(threadId);
    if (!thread) {
      return false;
    }
    await rm(thread.sessionFile);
    this.#database.deleteThread(threadId);
    return true;
  }
}
