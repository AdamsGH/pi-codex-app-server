import { existsSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import type { Project } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/Project.js";
import type { ProjectCreateParams } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/ProjectCreateParams.js";
import type { ProjectImportParams } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/ProjectImportParams.js";
import type { ProjectListParams } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/ProjectListParams.js";
import type { ProjectMoveParams } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/ProjectMoveParams.js";
import type { ProjectUpdateParams } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/ProjectUpdateParams.js";
import type { MetadataDatabase } from "../storage/metadata-database.js";
import type { StoredProject } from "../storage/metadata-records.js";
import { uuidV7 } from "../storage/uuid-v7.js";

const cursorSchema = z
  .string()
  .regex(/^pi-projects:\d+$/u)
  .transform((value) => Number(value.slice(12)));
const normalizePath = (value: string): string =>
  process.platform === "win32"
    ? path.resolve(value).toLowerCase()
    : path.resolve(value);
const projectResponse = (project: StoredProject): Project => ({
  ...project,
  roots: [...project.roots],
});

export const findRepositoryRoot = (cwd: string): string | undefined => {
  let directory = path.resolve(cwd);
  if (!existsSync(directory)) {
    return undefined;
  }
  while (true) {
    if (existsSync(path.join(directory, ".git"))) {
      return directory;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
};

export class PiProjectCatalog {
  readonly #database: MetadataDatabase;

  constructor(database: MetadataDatabase) {
    this.#database = database;
  }

  discover(cwd: string): string | null {
    const root = findRepositoryRoot(cwd);
    if (!root) {
      return null;
    }
    const normalized = normalizePath(root);
    if (
      this.#database.getRemoteState(`pi-project-deleted:${normalized}`) === true
    ) {
      return null;
    }
    const existing = this.#database
      .listProjects()
      .find((project) =>
        project.roots.some(
          ({ path: value }) => normalizePath(value) === normalized
        )
      );
    if (existing) {
      return existing.id;
    }
    return this.create({
      idempotencyKey: `pi-root:${normalized}`,
      name: path.basename(root),
      roots: [{ path: root }],
    }).project.id;
  }

  isAssigned(threadId: string): boolean {
    return (
      this.#database.getRemoteState(`pi-project-assigned:${threadId}`) === true
    );
  }

  assign(threadId: string, projectId: string | null): void {
    const thread = this.#database.getThread(threadId);
    if (!thread) {
      throw new Error(`Thread not found: ${threadId}`);
    }
    if (projectId) {
      this.read(projectId);
    }
    this.#database.upsertThread({ ...thread, projectId });
    this.#database.setRemoteState(`pi-project-assigned:${threadId}`, true);
  }

  list(params: ProjectListParams) {
    const all = this.#database.listProjects();
    const offset = params.cursor ? cursorSchema.parse(params.cursor) : 0;
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 500);
    const data = all.slice(offset, offset + limit).map(projectResponse);
    const next = offset + data.length;
    return {
      data,
      nextCursor: next < all.length ? `pi-projects:${next}` : null,
    };
  }

  read(projectId: string) {
    const project = this.#database
      .listProjects()
      .find(({ id }) => id === projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }
    return { project: projectResponse(project) };
  }

  create(params: ProjectCreateParams) {
    const stateKey = `pi-project-create:${params.idempotencyKey}`;
    const saved = this.#database.getRemoteState(stateKey);
    const parsed = z.string().safeParse(saved);
    if (parsed.success) {
      return this.read(parsed.data);
    }
    const now = Math.floor(Date.now() / 1000);
    const metadata = z
      .record(z.string(), z.string())
      .parse(params.metadata ?? {});
    const project: StoredProject = {
      createdAt: now,
      id: uuidV7(),
      metadata,
      name: params.name,
      position: this.#database.listProjects().length,
      roots: params.roots,
      updatedAt: now,
    };
    this.#database.upsertProject(project);
    this.#database.setRemoteState(stateKey, project.id);
    return { project: projectResponse(project) };
  }

  import(params: ProjectImportParams) {
    for (const threadId of params.threads ?? []) {
      if (!this.#database.getThread(threadId)) {
        throw new Error(`Thread not found: ${threadId}`);
      }
    }
    const response = this.create(params);
    for (const threadId of params.threads ?? []) {
      this.assign(threadId, response.project.id);
    }
    return response;
  }

  update(params: ProjectUpdateParams) {
    const { project } = this.read(params.projectId);
    const updated = {
      ...project,
      metadata: z
        .record(z.string(), z.string())
        .parse(params.metadata ?? project.metadata),
      name: params.name ?? project.name,
      roots: params.roots ?? project.roots,
      updatedAt: Math.floor(Date.now() / 1000),
    };
    this.#database.upsertProject(updated);
    return { project: updated };
  }

  delete(projectId: string): Record<string, never> {
    const { project } = this.read(projectId);
    for (const root of project.roots) {
      this.#database.setRemoteState(
        `pi-project-deleted:${normalizePath(root.path)}`,
        true
      );
    }
    this.#database.deleteProject(projectId);
    return {};
  }

  move(params: ProjectMoveParams): Record<string, never> {
    const { project } = this.read(params.projectId);
    if (params.beforeProjectId === params.projectId) {
      return {};
    }
    const all = this.#database
      .listProjects()
      .filter(({ id }) => id !== params.projectId);
    const position = params.beforeProjectId
      ? all.findIndex(({ id }) => id === params.beforeProjectId)
      : all.length;
    if (position < 0) {
      throw new Error(`Project not found: ${params.beforeProjectId}`);
    }
    all.splice(position, 0, {
      ...project,
      metadata: z.record(z.string(), z.string()).parse(project.metadata),
    });
    for (const [index, item] of all.entries()) {
      this.#database.upsertProject({ ...item, position: index });
    }
    return {};
  }
}
