import { once } from "node:events";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { SessionManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Command } from "commander";
import { WebSocket } from "ws";

import { DesktopNativeTools } from "../dist/desktop/native-tools.js";

const options = new Command()
  .description("Check automatic sidebar placement with a synthetic Pi session")
  .requiredOption("--host-id <id>", "Connected Pi host")
  .requiredOption("--section-id <id>", "Desktop custom section")
  .option(
    "--caller-thread-id <id>",
    "Actual local caller",
    process.env.CODEX_THREAD_ID
  )
  .option(
    "--pipe <path>",
    "Desktop-provided native endpoint",
    process.env.CODEX_APP_TOOLS_PIPE_PATH
  )
  .option(
    "--cwd <path>",
    "Working directory outside Git for the fixture",
    homedir()
  )
  .option(
    "--codex-home <path>",
    "Desktop state directory",
    process.env.CODEX_HOME ?? path.join(homedir(), ".codex")
  )
  .parse()
  .opts();
if (!options.callerThreadId || !options.pipe) {
  throw new Error("Use a desktop-provided endpoint and the actual caller task");
}
const serverHome =
  process.env.PI_CODEX_APP_SERVER_HOME ??
  path.join(getAgentDir(), "codex-app-server");
const endpoint = JSON.parse(
  fs.readFileSync(path.join(serverHome, "endpoint.json"), "utf-8")
);
try {
  process.kill(endpoint.pid, 0);
  const socket = new WebSocket(endpoint.url, { handshakeTimeout: 5000 });
  try {
    await once(socket, "open");
  } finally {
    socket.terminate();
  }
} catch (error) {
  throw new Error(
    "Start the Pi daemon before sidebar acceptance; no fixture was created",
    { cause: error }
  );
}
const desktopProbe = new DesktopNativeTools(options.pipe, {
  timeoutMs: 15_000,
});
try {
  const tools = await desktopProbe.listTools();
  if (!tools.some((tool) => tool.name === "move_thread_to_sidebar_section")) {
    throw new Error("Native desktop sidebar tools are unavailable");
  }
} finally {
  desktopProbe.close();
}
const evidenceDirectory = path.join(serverHome, "acceptance");
fs.mkdirSync(evidenceDirectory, { recursive: true });
const session = SessionManager.create(path.resolve(options.cwd));
session.appendMessage({
  content: "Synthetic sidebar acceptance fixture. No agent execution.",
  role: "user",
  timestamp: Date.now(),
});
session.appendSessionInfo("Bridge sidebar acceptance fixture");
session.appendMessage({
  api: "openai-responses",
  content: [{ text: "Fixture only. No model call.", type: "text" }],
  model: "fixture",
  provider: "test",
  role: "assistant",
  stopReason: "stop",
  timestamp: Date.now(),
  usage: {
    cacheRead: 0,
    cacheWrite: 0,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
    input: 0,
    output: 0,
    totalTokens: 0,
  },
});
const id = session.getSessionId();
const file = session.getSessionFile();
const evidencePath = path.join(evidenceDirectory, `${id}.json`);
fs.writeFileSync(evidencePath, JSON.stringify({ file, id, status: "created" }));
const savedItems = () => {
  const state = JSON.parse(
    fs.readFileSync(
      path.join(options.codexHome, ".codex-global-state.json"),
      "utf-8"
    )
  );
  const accounts =
    state["electron-persisted-atom-state"]["sidebar-custom-sections-v3"];
  const matches = Object.values(accounts)
    .flatMap((account) => account.sections)
    .filter((section) => section.id === options.sectionId);
  if (matches.length !== 1) {
    throw new Error("Expected exactly one desktop destination section");
  }
  return matches[0].itemKeys;
};
const started = Date.now();
const deadline = started + 90_000;
let confirmed = false;
while (Date.now() < deadline) {
  const items = savedItems();
  const log = fs.readFileSync(
    path.join(serverHome, "logs", "daemon.stdout.log"),
    "utf-8"
  );
  if (
    items.some((key) => key.endsWith(`:${id}`)) &&
    log
      .split("\n")
      .some((line) => line.includes(id) && line.includes('"synchronized"'))
  ) {
    if (items.filter((key) => key.endsWith(`:${id}`)).length !== 1) {
      throw new Error("Duplicate fixture membership");
    }
    if (
      !items.find((key) => key.startsWith("codex:thread:")).endsWith(`:${id}`)
    ) {
      throw new Error("Fixture is not the first chat");
    }
    confirmed = true;
    break;
  }
  // oxlint-disable-next-line no-await-in-loop -- Each poll observes a new desktop/daemon state.
  await delay(500);
}
if (!confirmed) {
  throw new Error(
    `Automatic membership timed out. Retained fixture: ${evidencePath}`
  );
}
const automaticMs = Date.now() - started;
await delay(6000);
if (savedItems().filter((key) => key.endsWith(`:${id}`)).length !== 1) {
  throw new Error("Membership changed on the next pass");
}
const client = new DesktopNativeTools(options.pipe, { timeoutMs: 45_000 });
try {
  const context = { threadId: options.callerThreadId };
  await client.call(
    "set_thread_archived",
    { archived: true, hostId: options.hostId, threadId: id },
    context
  );
  await client.call(
    "move_thread_to_sidebar_section",
    { hostId: options.hostId, sectionId: null, threadId: id },
    context
  );
  if (savedItems().some((key) => key.endsWith(`:${id}`))) {
    throw new Error("Fixture removal not confirmed; retained history");
  }
  const root = path.resolve(session.getSessionDir());
  const target = file ? path.resolve(file) : "";
  if (
    !target.startsWith(root + path.sep) ||
    !path.basename(target).includes(id)
  ) {
    throw new Error("Fixture cleanup boundary mismatch");
  }
  fs.unlinkSync(target);
  const result = {
    automaticMs,
    fixtureCleaned: true,
    id,
    status: "passed",
    visibleUiVerified: false,
  };
  fs.writeFileSync(evidencePath, JSON.stringify(result));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  client.close();
}
