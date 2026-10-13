import { z } from "zod";

import type { ThreadSection } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/ThreadSection.js";
import type { ThreadSectionCreateParams } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/ThreadSectionCreateParams.js";
import type { ThreadSectionListParams } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/ThreadSectionListParams.js";
import type { ThreadSectionMoveParams } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/ThreadSectionMoveParams.js";
import type { ThreadSectionUpdateParams } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/ThreadSectionUpdateParams.js";
import type { MetadataDatabase } from "../storage/metadata-database.js";
import { uuidV7 } from "../storage/uuid-v7.js";

const STATE_KEY = "pi-thread-sections/v1";
const appearanceSchema = z.object({
  color: z.string().nullable(),
  icon: z.string().nullable(),
});
const stateSchema = z.object({
  defaultSectionId: z.string().nullable(),
  sections: z.array(
    z.object({
      appearance: appearanceSchema.nullable(),
      id: z.string(),
      name: z.string(),
    })
  ),
  threads: z.record(
    z.string(),
    z.object({
      enteredAt: z.number().nullable(),
      manualOrder: z.boolean().optional(),
      position: z.number(),
      sectionId: z.string().nullable(),
    })
  ),
});
type State = z.infer<typeof stateSchema>;
const cursorSchema = z
  .string()
  .regex(/^pi-sections:\d+$/u)
  .transform((cursor) => Number(cursor.slice("pi-sections:".length)));

interface SectionMembership {
  section: ThreadSection | null;
  sectionEnteredAt: number | null;
  position: number;
  sortPosition: number;
}

export class PiThreadSections {
  readonly #database: MetadataDatabase;

  constructor(database: MetadataDatabase) {
    this.#database = database;
  }

  #load(): State {
    const stored = this.#database.getRemoteState(STATE_KEY);
    if (stored !== undefined) {
      return stateSchema.parse(stored);
    }
    const section = { appearance: null, id: uuidV7(), name: "Pi" };
    const state: State = {
      defaultSectionId: section.id,
      sections: [section],
      threads: {},
    };
    this.#database.setRemoteState(STATE_KEY, state);
    return state;
  }

  #sectionId(state: State, threadId: string): string | null {
    const membership = state.threads[threadId];
    const projectId = this.#database.getThread(threadId)?.projectId;
    if (
      membership &&
      (membership.sectionId !== state.defaultSectionId ||
        membership.enteredAt !== null ||
        !projectId)
    ) {
      return membership.sectionId;
    }
    return projectId ? null : state.defaultSectionId;
  }

  get(threadId: string): SectionMembership {
    const state = this.#load();
    const membership = state.threads[threadId];
    const sectionId = this.#sectionId(state, threadId);
    const automatic =
      state.defaultSectionId !== null &&
      sectionId === state.defaultSectionId &&
      (membership?.enteredAt ?? null) === null &&
      membership?.manualOrder !== true;
    const position = automatic
      ? (this.#database.getThread(threadId)?.updatedAt ?? 0)
      : (membership?.position ?? 0);
    return {
      position,
      section: state.sections.find(({ id }) => id === sectionId) ?? null,
      sectionEnteredAt: membership?.enteredAt ?? null,
      sortPosition: automatic ? position : -position,
    };
  }

  list(params: ThreadSectionListParams) {
    const state = this.#load();
    const offset = params.cursor ? cursorSchema.parse(params.cursor) : 0;
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 500);
    const data = state.sections.slice(offset, offset + limit);
    const next = offset + data.length;
    return {
      data,
      nextCursor: next < state.sections.length ? `pi-sections:${next}` : null,
    };
  }

  create(params: ThreadSectionCreateParams) {
    const state = this.#load();
    const existing = state.sections.find(
      ({ id, name }) => id === state.defaultSectionId && name === params.name
    );
    if (existing) {
      return { section: existing };
    }
    const section: ThreadSection = {
      appearance: params.appearance ?? null,
      id: uuidV7(),
      name: params.name,
    };
    state.sections.push(section);
    this.#database.setRemoteState(STATE_KEY, state);
    return { section };
  }

  update(params: ThreadSectionUpdateParams) {
    const state = this.#load();
    const section = state.sections.find(({ id }) => id === params.sectionId);
    if (!section) {
      throw new Error(`Section not found: ${params.sectionId}`);
    }
    section.name = params.name;
    if (params.appearance !== undefined) {
      section.appearance = params.appearance;
    }
    this.#database.setRemoteState(STATE_KEY, state);
    return { section };
  }

  delete(sectionId: string): Record<string, never> {
    const state = this.#load();
    if (!state.sections.some(({ id }) => id === sectionId)) {
      throw new Error(`Section not found: ${sectionId}`);
    }
    state.sections = state.sections.filter(({ id }) => id !== sectionId);
    if (state.defaultSectionId === sectionId) {
      state.defaultSectionId = null;
    }
    for (const membership of Object.values(state.threads)) {
      if (membership.sectionId === sectionId) {
        membership.sectionId = null;
        membership.enteredAt = null;
      }
    }
    this.#database.setRemoteState(STATE_KEY, state);
    return {};
  }

  move(params: ThreadSectionMoveParams): Record<string, never> {
    if (!this.#database.getThread(params.threadId)) {
      throw new Error(`Thread not found: ${params.threadId}`);
    }
    const state = this.#load();
    if (
      params.sectionId !== null &&
      !state.sections.some(({ id }) => id === params.sectionId)
    ) {
      throw new Error(`Section not found: ${params.sectionId}`);
    }
    const membership = state.threads[params.threadId];
    const members = this.#database
      .listThreads()
      .filter(
        ({ threadId }) =>
          threadId !== params.threadId &&
          this.#sectionId(state, threadId) === params.sectionId
      )
      .toSorted(
        (a, b) =>
          this.get(b.threadId).sortPosition - this.get(a.threadId).sortPosition
      )
      .map(({ threadId }) => threadId);
    if (params.beforeThreadId === params.threadId) {
      return {};
    }
    let position = members.length;
    if (params.beforeThreadId) {
      position = members.indexOf(params.beforeThreadId);
      if (position < 0) {
        throw new Error(
          "The insertion reference is not in the destination section"
        );
      }
    }
    members.splice(position, 0, params.threadId);
    let enteredAt: number | null = null;
    if (params.sectionId !== null) {
      enteredAt =
        membership?.sectionId === params.sectionId &&
        membership.enteredAt !== null
          ? membership.enteredAt
          : Math.floor(Date.now() / 1000);
    }
    state.threads[params.threadId] = {
      enteredAt,
      manualOrder: true,
      position,
      sectionId: params.sectionId,
    };
    for (const [index, threadId] of members.entries()) {
      const member = state.threads[threadId];
      if (member) {
        member.position = index;
        member.manualOrder = true;
      } else {
        state.threads[threadId] = {
          enteredAt: null,
          manualOrder: true,
          position: index,
          sectionId: params.sectionId,
        };
      }
    }
    this.#database.setRemoteState(STATE_KEY, state);
    return {};
  }
}
