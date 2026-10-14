import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  SessionManager,
  parseSessionEntries,
} from "@earendil-works/pi-coding-agent";
import type {
  SessionEntry,
  SessionInfo,
} from "@earendil-works/pi-coding-agent";
import { z } from "zod";

import type { MetadataDatabase } from "../storage/metadata-database.js";
import { PiProjectCatalog } from "./project-catalog.js";

const messageTextSchema = z.union([
  z.string(),
  z
    .array(z.looseObject({ text: z.string().optional(), type: z.string() }))
    .transform((content) =>
      content
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join(" ")
    ),
]);

const summarizeMessages = (manager: SessionManager) => {
  let activity = 0;
  let messageCount = 0;
  let firstMessage = "";
  const messages: string[] = [];
  for (const entry of manager.getEntries()) {
    if (entry.type !== "message") {
      continue;
    }
    messageCount += 1;
    const { message } = entry;
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }
    const parsedTimestamp = z.number().safeParse(message.timestamp);
    const timestamp = parsedTimestamp.success
      ? parsedTimestamp.data
      : new Date(entry.timestamp).getTime();
    if (Number.isFinite(timestamp)) {
      activity = Math.max(activity, timestamp);
    }
    const text = messageTextSchema.parse(message.content);
    if (text) {
      messages.push(text);
      if (!firstMessage && message.role === "user") {
        firstMessage = text;
      }
    }
  }
  return {
    activity,
    allMessagesText: messages.join(" "),
    firstMessage: firstMessage || "(no messages)",
    messageCount,
  };
};

export class PiSessionRepository {
  readonly projects: PiProjectCatalog;
  readonly #database: MetadataDatabase;

  constructor(database: MetadataDatabase) {
    this.#database = database;
    this.projects = new PiProjectCatalog(database);
  }

  async list(): Promise<readonly SessionInfo[]> {
    const listed = await SessionManager.listAll();
    const sessions = listed.map((session) =>
      session.created > session.modified
        ? { ...session, modified: session.created }
        : session
    );
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

  async read(threadId: string): Promise<
    | {
        info: SessionInfo;
        manager: SessionManager;
      }
    | undefined
  > {
    let metadata = this.#database.getThread(threadId);
    if (!metadata) {
      await this.list();
      metadata = this.#database.getThread(threadId);
    }
    if (!metadata) {
      return undefined;
    }
    let modified: Date;
    let manager: SessionManager;
    try {
      const entries = parseSessionEntries(
        await readFile(metadata.sessionFile, "utf-8")
      );
      const header = entries.find((entry) => entry.type === "session");
      if (!header || header.id !== threadId) {
        return undefined;
      }
      // SessionManager.open repairs JSONL on disk. Catalog reads must not mutate the owner's file.
      manager = SessionManager.inMemory(header.cwd, undefined, entries);
      const stats = await stat(metadata.sessionFile);
      modified = stats.mtime;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    }
    const header = manager.getHeader();
    if (!header || header.id !== threadId) {
      return undefined;
    }
    const created = new Date(header.timestamp);
    const { activity, ...summary } = summarizeMessages(manager);
    if (activity > 0) {
      modified = new Date(
        Math.max(
          activity,
          Number.isFinite(created.getTime()) ? created.getTime() : activity
        )
      );
    } else if (Number.isFinite(created.getTime())) {
      modified = created;
    }
    const info: SessionInfo = {
      ...summary,
      created,
      cwd: manager.getCwd(),
      id: threadId,
      modified,
      name: manager.getSessionName(),
      parentSessionPath: header.parentSession,
      path: metadata.sessionFile,
    };
    this.#database.upsertThread({ ...metadata, updatedAt: modified.getTime() });
    return { info, manager };
  }

  async delete(threadId: string): Promise<boolean> {
    let thread = this.#database.getThread(threadId);
    if (!thread) {
      await this.list();
      thread = this.#database.getThread(threadId);
    }
    if (!thread) {
      return false;
    }
    await rm(thread.sessionFile);
    this.#database.deleteThread(threadId);
    return true;
  }

  async fork(
    source: SessionManager,
    entries: readonly SessionEntry[],
    cwd: string,
    sessionDir?: string
  ): Promise<string> {
    const manager = SessionManager.create(cwd, sessionDir, {
      parentSession: source.getSessionFile(),
    });
    const file = manager.getSessionFile();
    const header = manager.getHeader();
    if (!(file && header)) {
      throw new Error("Pi did not create a fork session path");
    }
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      `${[header, ...entries]
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
      { flag: "wx" }
    );
    const threadId = manager.getSessionId();
    this.#database.upsertThread({
      archived: false,
      projectId: this.projects.discover(cwd),
      sessionFile: file,
      threadId,
      updatedAt: Date.now(),
    });
    return threadId;
  }
}
