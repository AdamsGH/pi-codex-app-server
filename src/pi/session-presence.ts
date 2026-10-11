import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

const presenceSchema = z.object({
  pid: z.number().int().positive(),
  threadId: z.string().min(1),
  touchedAt: z.number(),
});
const HEARTBEAT_MS = 10_000;
const EXPIRES_MS = 30_000;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

export const readPiPresence = async (
  home: string
): Promise<ReadonlySet<string>> => {
  const directory = path.join(home, "presence");
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return new Set();
    }
    throw error;
  }
  const records = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => {
        try {
          const record = presenceSchema.parse(
            JSON.parse(await readFile(path.join(directory, file), "utf-8"))
          );
          return record.touchedAt <= Date.now() + HEARTBEAT_MS &&
            Date.now() - record.touchedAt <= EXPIRES_MS &&
            alive(record.pid)
            ? record.threadId
            : undefined;
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code !== "ENOENT"
          ) {
            throw error;
          }
        }
      })
  );
  return new Set(records.filter((id): id is string => id !== undefined));
};

export class PiSessionPresence {
  readonly #file: string;
  #timer?: ReturnType<typeof setInterval>;
  #pending: Promise<void> = Promise.resolve();

  constructor(home: string) {
    this.#file = path.join(
      home,
      "presence",
      `${process.pid}-${randomUUID()}.json`
    );
  }

  async start(threadId: string): Promise<void> {
    await this.stop();
    await mkdir(path.dirname(this.#file), { recursive: true });
    const touch = async (): Promise<void> => {
      const temporary = `${this.#file}.tmp`;
      await writeFile(
        temporary,
        JSON.stringify({ pid: process.pid, threadId, touchedAt: Date.now() }),
        { mode: 0o600 }
      );
      await rename(temporary, this.#file);
    };
    await touch();
    this.#timer = setInterval(() => {
      this.#pending = this.#heartbeat(touch);
    }, HEARTBEAT_MS);
    this.#timer.unref();
  }

  async #heartbeat(touch: () => Promise<void>): Promise<void> {
    try {
      await this.#pending;
      await touch();
    } catch {
      // Failed heartbeats expire the record instead of claiming a dead session.
    }
  }

  async stop(): Promise<void> {
    clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#pending;
    await rm(this.#file, { force: true });
    await rm(`${this.#file}.tmp`, { force: true });
  }
}
