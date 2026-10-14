import type { Dirent } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  SessionManager,
  getAgentDir,
  parseSessionEntries,
} from "@earendil-works/pi-coding-agent";
import type {
  FileEntry,
  SessionEntry,
  SessionInfo,
} from "@earendil-works/pi-coding-agent";
import { z } from "zod";

import type { MetadataDatabase } from "../storage/metadata-database.js";
import type { ThreadMetadata } from "../storage/metadata-records.js";
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

const summarizeMessages = (entries: readonly FileEntry[]) => {
  let activity = 0;
  let messageCount = 0;
  let firstMessage = "";
  const messages: string[] = [];
  for (const entry of entries) {
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
  readonly #sessionDir: string;
  readonly #summaries = new Map<
    string,
    { fingerprint: string; info: SessionInfo }
  >();
  #listing?: Promise<readonly SessionInfo[]>;

  constructor(
    database: MetadataDatabase,
    sessionDir = path.join(getAgentDir(), "sessions")
  ) {
    this.#database = database;
    this.#sessionDir = sessionDir;
    this.projects = new PiProjectCatalog(database);
  }

  list(): Promise<readonly SessionInfo[]> {
    // Publication and client requests share one scan; neither may replay a full history scan concurrently.
    this.#listing ??= this.#runList();
    return this.#listing;
  }

  async #runList(): Promise<readonly SessionInfo[]> {
    try {
      return await this.#list();
    } finally {
      this.#listing = undefined;
    }
  }

  async #list(): Promise<readonly SessionInfo[]> {
    let directories: Dirent[];
    try {
      directories = await readdir(this.#sessionDir, { withFileTypes: true });
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      ) {
        throw error;
      }
      directories = [];
    }
    const directoryFiles = await Promise.all(
      directories
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map(async (entry) => {
          const directory = path.join(this.#sessionDir, entry.name);
          try {
            const entries = await readdir(directory);
            return entries
              .filter((file) => file.endsWith(".jsonl"))
              .map((file) => path.join(directory, file));
          } catch (error) {
            if (
              error instanceof Error &&
              "code" in error &&
              (error.code === "ENOENT" || error.code === "ENOTDIR")
            ) {
              return [];
            }
            throw error;
          }
        })
    );
    const files = directoryFiles.flat();
    const present = new Set(files);
    for (const file of this.#summaries.keys()) {
      if (!present.has(file)) {
        this.#summaries.delete(file);
      }
    }
    const listed: SessionInfo[] = [];
    for (let offset = 0; offset < files.length; offset += 16) {
      // eslint-disable-next-line no-await-in-loop -- Bound open files and concurrent JSONL parsing.
      await Promise.all(
        files.slice(offset, offset + 16).map(async (file) => {
          try {
            const stats = await stat(file);
            const fingerprint = `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
            let cached = this.#summaries.get(file);
            if (cached?.fingerprint !== fingerprint) {
              const entries = parseSessionEntries(
                await readFile(file, "utf-8")
              ).filter((entry) => entry !== null);
              const header = entries.find((entry) => entry.type === "session");
              if (!header) {
                this.#summaries.delete(file);
                return;
              }
              const { activity, ...summary } = summarizeMessages(entries);
              const created = new Date(header.timestamp);
              cached = {
                fingerprint,
                info: {
                  ...summary,
                  created,
                  cwd: header.cwd,
                  id: header.id,
                  modified: new Date(
                    activity > 0
                      ? Math.max(activity, created.getTime())
                      : created.getTime()
                  ),
                  name:
                    entries
                      .findLast((entry) => entry.type === "session_info")
                      ?.name?.trim() || undefined,
                  parentSessionPath: header.parentSession,
                  path: file,
                },
              };
              this.#summaries.set(file, cached);
            }
            listed.push(cached.info);
          } catch (error) {
            if (error instanceof z.ZodError || error instanceof TypeError) {
              this.#summaries.delete(file);
              return;
            }
            if (
              error instanceof Error &&
              "code" in error &&
              error.code === "ENOENT"
            ) {
              this.#summaries.delete(file);
              return;
            }
            throw error;
          }
        })
      );
    }
    const sessions = listed.map((session) =>
      session.created > session.modified
        ? { ...session, modified: session.created }
        : session
    );
    sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
    this.#persistCatalog(sessions);
    return sessions;
  }

  #persistCatalog(sessions: readonly SessionInfo[]): void {
    const projects = new Map<string, string | null>();
    const updates: ThreadMetadata[] = [];
    for (const session of sessions) {
      const stored = this.#database.getThread(session.id);
      if (!projects.has(session.cwd)) {
        projects.set(session.cwd, this.projects.discover(session.cwd));
      }
      const projectId = this.projects.isAssigned(session.id)
        ? (stored?.projectId ?? null)
        : (stored?.projectId ?? projects.get(session.cwd) ?? null);
      if (
        stored &&
        stored.projectId === projectId &&
        stored.sessionFile === session.path &&
        stored.updatedAt === session.modified.getTime()
      ) {
        continue;
      }
      updates.push({
        archived: stored?.archived ?? false,
        projectId,
        sessionFile: session.path,
        threadId: session.id,
        updatedAt: session.modified.getTime(),
      });
    }
    // One durable commit per refresh instead of one fsync per discovered session.
    this.#database.upsertThreads(updates);
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
    const { activity, ...summary } = summarizeMessages(manager.getEntries());
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
