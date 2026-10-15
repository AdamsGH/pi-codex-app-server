import { createHash } from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";

import { Command } from "commander";
import ts from "typescript";
import { z } from "zod";

const MODULE = "src-DCNiwad_.js";
const DIGEST =
  "86fb2066bbc2f7428864b76b46ef570b09eb1e92e81e9d6f089f5b048a66df25";
const entrySchema = z.object({
  offset: z.string().regex(/^\d+$/u),
  size: z
    .number()
    .int()
    .positive()
    .max(8 * 1024 * 1024),
});
const headerSchema = z.object({
  files: z.object({
    ".vite": z.object({
      files: z.object({
        build: z.object({ files: z.object({ [MODULE]: entrySchema }) }),
      }),
    }),
  }),
});
const options = new Command()
  .requiredOption("--asar <path>", "Installed desktop app.asar, read only")
  .parse()
  .opts();

const readSource = (file) => {
  const fd = fs.openSync(file, "r");
  const read = (size, position) => {
    const bytes = Buffer.alloc(size);
    if (fs.readSync(fd, bytes, 0, size, position) !== size) {
      throw new Error("Truncated desktop archive");
    }
    return bytes;
  };
  try {
    const size = read(8, 0).readUInt32LE(4);
    if (size < 8 || size > 8 * 1024 * 1024) {
      throw new Error("Invalid desktop archive header size");
    }
    const header = read(size, 8);
    const metadata = headerSchema.parse(
      JSON.parse(header.subarray(8, 8 + header.readUInt32LE(4)).toString())
    );
    const entry = metadata.files[".vite"].files.build.files[MODULE];
    const source = read(entry.size, 8 + size + Number(entry.offset));
    if (createHash("sha256").update(source).digest("hex") !== DIGEST) {
      throw new Error(
        "Unsupported desktop source digest. Inspect the installed source before updating this probe."
      );
    }
    return source.toString();
  } finally {
    fs.closeSync(fd);
  }
};

const source = readSource(options.asar);
const tree = ts.createSourceFile(
  "desktop.js",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS
);
const declarations = new Map();
const names = new Set(["nh", "rh", "ih", "ah", "Zp", "oh"]);
const visit = (node) => {
  if (ts.isFunctionDeclaration(node) && names.has(node.name?.text)) {
    declarations.set(node.name.text, node.getText(tree));
  }
  if (
    ts.isVariableDeclaration(node) &&
    names.has(node.name.getText(tree)) &&
    node.initializer
  ) {
    declarations.set(
      node.name.getText(tree),
      `const ${node.name.getText(tree)} = ${node.initializer.getText(tree)};`
    );
  }
  ts.forEachChild(node, visit);
};
visit(tree);
if (declarations.size !== names.size) {
  throw new Error(
    "Installed ownership declarations do not match the reviewed probe"
  );
}
const StreamState = vm.runInNewContext(
  `${[...names].map((name) => declarations.get(name)).join("\n")}\noh`,
  {},
  { timeout: 1000 }
);
const packets = [];
const states = new Map();
const observed = { callbacks: 0, logs: 0, roleChanges: 0 };
const thread = "synthetic-thread";
for (const id of ["A", "B"]) {
  let conversation = {
    createdAt: 1,
    hostId: "synthetic-host",
    id: thread,
    turns: [],
    turnsPagination: {},
    updatedAt: 1,
  };
  const state = new StreamState({
    events: {
      emitStreamRole: () => {
        observed.roleChanges += 1;
      },
    },
    hostId: "synthetic-host",
    isCloudHost: false,
    isLocalHost: () => false,
    logger: {
      info: () => {
        observed.logs += 1;
      },
      warning: () => {
        throw new Error("Unexpected desktop fixture warning");
      },
    },
    threadStore: {
      getConversation: () => conversation,
      notifyConversationCallbacks: () => {
        observed.callbacks += 1;
      },
      setConversation: (value) => {
        conversation = value;
      },
    },
    transport: {
      requestFollowingStatus: () => Promise.resolve(),
      sendSnapshot: (_thread, _host, targets, revision, value) => {
        packets.push({
          sender: id,
          snapshot: {
            conversationState: structuredClone(value),
            revision,
            type: "snapshot",
          },
          targets,
        });
        return Promise.resolve();
      },
    },
  });
  state.streamRoles.set(thread, { role: "owner" });
  state.followedConversationIds.add(thread);
  state.followerClientIdsByConversationId.set(
    thread,
    new Set([id === "A" ? "B" : "A"])
  );
  states.set(id, state);
}
const roles = () =>
  Object.fromEntries(
    [...states].map(([id, state]) => [id, state.getStreamRole(thread)])
  );
const before = roles();
for (const state of states.values()) {
  state.broadcastConversationSnapshot(thread);
}
for (const packet of packets) {
  for (const target of packet.targets) {
    states
      .get(target)
      .handleThreadStreamStateChanged(thread, packet.snapshot, packet.sender);
  }
}
const owners = [...states.values()].filter(
  (state) => state.getStreamRole(thread)?.role === "owner"
).length;
console.log(
  JSON.stringify({
    after: roles(),
    before,
    observed,
    owners,
    sourceDigest: DIGEST,
  })
);
if (owners !== 0) {
  throw new Error("The reviewed ownership race did not reproduce");
}
