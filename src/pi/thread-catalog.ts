import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { orderBy } from "es-toolkit";
import { z } from "zod";

import type { Thread } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/Thread.js";
import type { ThreadListParams } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/ThreadListParams.js";
import type { ThreadListResponse } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/ThreadListResponse.js";
import type { MetadataDatabase } from "../storage/metadata-database.js";
import type { ThreadMetadata } from "../storage/metadata-records.js";
import { projectPiConversation } from "./conversation-projector.js";
import type { PiSessionPublication } from "./session-publication.js";
import type { PiSessionRepository } from "./session-repository.js";
import { PiThreadSections } from "./thread-sections.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;
const CURSOR_PREFIX = "pi-threads:";
const cursorSchema = z
  .string()
  .regex(/^pi-threads:\d+$/u)
  .transform((cursor) =>
    Math.trunc(Number(cursor.slice(CURSOR_PREFIX.length)))
  );

const epochSeconds = (date: Date): number => Math.floor(date.getTime() / 1000);

const requestedWorkingDirectories = (
  cwd: ThreadListParams["cwd"]
): ReadonlySet<string> | undefined => {
  if (!cwd) {
    return undefined;
  }
  return new Set(Array.isArray(cwd) ? cwd : [cwd]);
};

const sortTimestamp = (
  thread: Thread,
  sortKey: ThreadListParams["sortKey"]
): number => {
  if (sortKey === "created_at") {
    return thread.createdAt;
  }
  return thread.updatedAt;
};

const projectThread = (
  session: SessionInfo,
  metadata?: ThreadMetadata,
  modelProvider = "pi"
): Thread => {
  const createdAt = epochSeconds(session.created);
  const updatedAt = epochSeconds(session.modified);
  return {
    agentNickname: null,
    agentRole: null,
    canAcceptDirectInput: null,
    cliVersion: "pi-0.84",
    createdAt,
    cwd: session.cwd,
    ephemeral: false,
    extra: null,
    forkedFromId: null,
    gitInfo: null,
    historyMode: "legacy",
    id: session.id,
    modelProvider,
    name: session.name ?? null,
    parentThreadId: null,
    path: session.path,
    preview: session.firstMessage,
    projectId: metadata?.projectId ?? null,
    recencyAt: updatedAt,
    section: null,
    sectionEnteredAt: null,
    sessionId: session.id,
    source: { custom: "pi" },
    status: { type: "notLoaded" },
    threadSource: "pi",
    turns: [],
    updatedAt,
  };
};

export class PiThreadCatalog {
  readonly #database: MetadataDatabase;
  readonly #sessionRepository: PiSessionRepository;
  readonly sections: PiThreadSections;
  readonly publication?: PiSessionPublication;

  constructor(options: {
    readonly database: MetadataDatabase;
    readonly sessionRepository: PiSessionRepository;
    readonly publication?: PiSessionPublication;
  }) {
    this.#database = options.database;
    this.#sessionRepository = options.sessionRepository;
    this.sections = new PiThreadSections(options.database);
    this.publication = options.publication;
  }

  async list(params: ThreadListParams): Promise<ThreadListResponse> {
    const all = await this.#sessionRepository.list();
    const sessions = this.publication
      ? await this.publication.select(all)
      : all;
    const requestedCwds = requestedWorkingDirectories(params.cwd);
    const requestedArchived = params.archived === true;
    const normalizedSearch = params.searchTerm?.trim().toLocaleLowerCase();
    const threads = sessions
      .filter((session) => {
        const metadata = this.#database.getThread(session.id);
        const archived = metadata?.archived ?? false;
        const cwdMatches = !requestedCwds || requestedCwds.has(session.cwd);
        const archiveMatches = archived === requestedArchived;
        const sectionMatches =
          params.sectionId === undefined ||
          this.sections.get(session.id).section?.id === params.sectionId ||
          (params.sectionId === null &&
            this.sections.get(session.id).section === null);
        const searchMatches =
          !normalizedSearch ||
          session.name?.toLocaleLowerCase().includes(normalizedSearch) ||
          session.firstMessage.toLocaleLowerCase().includes(normalizedSearch);
        const projectMatches =
          params.projectId === undefined ||
          (metadata?.projectId ?? null) === params.projectId;
        return (
          cwdMatches &&
          archiveMatches &&
          searchMatches &&
          sectionMatches &&
          projectMatches
        );
      })
      .map((session) => {
        const { position: _position, ...section } = this.sections.get(
          session.id
        );
        return {
          ...projectThread(session, this.#database.getThread(session.id)),
          ...section,
        };
      });
    const direction = params.sortDirection ?? "desc";
    const sorted = orderBy(
      threads,
      [
        (thread) =>
          params.sortKey === "section_position"
            ? this.sections.get(thread.id).position
            : sortTimestamp(thread, params.sortKey),
        "id",
      ],
      [direction, direction]
    );
    const offset = params.cursor ? cursorSchema.parse(params.cursor) : 0;
    const pageSize = Math.min(
      Math.max(params.limit ?? DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE
    );
    const page = sorted.slice(offset, offset + pageSize);
    const nextOffset = offset + page.length;
    return {
      backwardsCursor: page.length > 0 ? `${CURSOR_PREFIX}${offset}` : null,
      data: page,
      nextCursor:
        nextOffset < sorted.length ? `${CURSOR_PREFIX}${nextOffset}` : null,
    };
  }

  describe(session: SessionInfo): Thread {
    const { position: _position, ...section } = this.sections.get(session.id);
    return {
      ...projectThread(session, this.#database.getThread(session.id)),
      ...section,
    };
  }

  async read(
    threadId: string,
    includeTurns = false
  ): Promise<Thread | undefined> {
    const loaded = await this.#sessionRepository.read(threadId);
    if (!loaded) {
      return undefined;
    }
    const { info: session, manager: sessionManager } = loaded;
    const published = this.publication
      ? await this.publication.select([session])
      : [session];
    if (published.length === 0) {
      return undefined;
    }
    const sessionContext = sessionManager?.buildSessionContext();
    const thread = projectThread(
      session,
      this.#database.getThread(threadId),
      sessionContext?.model?.provider
    );
    const { position: _position, ...section } = this.sections.get(threadId);
    Object.assign(thread, section);
    thread.forkedFromId = session.parentSessionPath
      ? (this.#database
          .listThreads()
          .find(
            (metadata) => metadata.sessionFile === session.parentSessionPath
          )?.threadId ?? null)
      : null;
    if (includeTurns && sessionManager) {
      thread.turns = [
        ...projectPiConversation(
          sessionManager.getBranch(),
          sessionManager.getCwd()
        ),
      ];
    }
    return thread;
  }
}
