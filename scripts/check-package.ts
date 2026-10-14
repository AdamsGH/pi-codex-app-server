import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

const root = path.resolve(import.meta.dir, "..");
const manifest = z
  .object({
    devDependencies: z.record(z.string(), z.string()),
    name: z.string().regex(/^@pi-switch\/pi-codex-app-server$/u),
    version: z.string(),
  })
  .parse(JSON.parse(await readFile(path.join(root, "package.json"), "utf-8")));
const cache = path.join(root, ".cache");
await mkdir(cache, { recursive: true });
const workspace = await mkdtemp(path.join(cache, "package-check-"));
const npmExecutable = Bun.which("npm");
const nodeExecutable = Bun.which("node");
if (!npmExecutable || !nodeExecutable) {
  throw new Error("Package verification requires Node.js and npm on PATH");
}
const npmCli =
  process.platform === "win32"
    ? path.join(path.dirname(npmExecutable), "node_modules/npm/bin/npm-cli.js")
    : await realpath(npmExecutable);
const run = async (command: string[], cwd: string): Promise<string> => {
  const executable =
    command[0] === "npm"
      ? [nodeExecutable, npmCli, ...command.slice(1)]
      : [nodeExecutable, ...command.slice(1)];
  const child = Bun.spawn(executable, {
    cwd,
    env: {
      ...process.env,
      HUSKY: "0",
      PI_CODEX_APP_SERVER_AUTOSTART: "0",
      PI_CODEX_APP_SERVER_HOME: path.join(workspace, "server"),
      PI_CODEX_REMOTE_CONTROL: "0",
      PI_CODING_AGENT_DIR: path.join(workspace, "pi-agent"),
    },
    stderr: "pipe",
    stdout: "pipe",
    timeout: 180_000,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    throw new Error(
      `Package check command failed: ${command[0]} (${code})\n${stderr}`
    );
  }
  return stdout;
};
try {
  const [packed] = z
    .array(
      z.object({
        filename: z.string(),
        files: z.array(z.object({ path: z.string() })),
        name: z.string(),
        version: z.string(),
      })
    )
    .length(1)
    .parse(
      JSON.parse(
        await run(
          [
            "npm",
            "pack",
            "--ignore-scripts",
            "--json",
            "--pack-destination",
            workspace,
          ],
          root
        )
      )
    );
  if (
    !packed ||
    packed.name !== manifest.name ||
    packed.version !== manifest.version
  ) {
    throw new Error("Packed identity differs from package.json");
  }
  const names = new Set(packed.files.map((file) => file.path));
  for (const required of [
    "dist/cli.js",
    "dist/index.js",
    "dist/desktop-sync.js",
    "dist/sidebar-sync.js",
    "src/extension/index.ts",
    "src/index.ts",
    "README.md",
    "LICENSE",
    "NOTICE",
    "docs/user-guide.md",
    "docs/development.md",
    "docs/architecture.md",
    "docs/sidebar-sync.md",
    "vendor/openai-codex-app-server-protocol/protocol-snapshot.json",
    "vendor/openai-codex-app-server-protocol/UPSTREAM.md",
  ]) {
    if (!names.has(required)) {
      throw new Error(`Required package file is missing: ${required}`);
    }
  }
  if (
    !packed.files.some(
      (file) =>
        file.path.startsWith("drizzle/") && file.path.endsWith("/migration.sql")
    )
  ) {
    throw new Error("Package has no database migrations");
  }
  if (
    packed.files.some((file) =>
      /(?:^|\/)(?:\.env|auth\.json|state\.sqlite|node_modules|\.cache|\.agents)(?:$|[./])/u.test(
        file.path
      )
    )
  ) {
    throw new Error("Package contains local runtime state or dependencies");
  }
  await writeFile(
    path.join(workspace, "package.json"),
    JSON.stringify({ private: true })
  );
  const peers = ["pi-ai", "pi-agent-core", "pi-coding-agent", "pi-tui"].map(
    (name) =>
      `@earendil-works/${name}@${manifest.devDependencies[`@earendil-works/${name}`]}`
  );
  await run(
    [
      "npm",
      "install",
      "--ignore-scripts",
      "--no-package-lock",
      "--no-audit",
      "--no-fund",
      path.join(workspace, packed.filename),
      ...peers,
    ],
    workspace
  );
  const smoke = path.join(workspace, "smoke.mjs");
  await writeFile(
    smoke,
    `import { readdir } from "node:fs/promises";
import path from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
const { MetadataDatabase } = await import(${JSON.stringify(manifest.name)});
const database = new MetadataDatabase(":memory:");
if (database.listProjects().length !== 0) throw new Error("Unexpected fresh database state");
database.close();
const settings = SettingsManager.inMemory({});
const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: process.env.PI_CODING_AGENT_DIR,
  additionalExtensionPaths: [path.join(process.cwd(), "node_modules", ${JSON.stringify(manifest.name)}, "src/extension/index.ts")],
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
  settingsManager: settings,
});
await loader.reload();
if (loader.getExtensions().errors.length !== 0) throw new Error("Installed extension failed to load");
const modelRuntime = await ModelRuntime.create({ authPath: path.join(process.env.PI_CODING_AGENT_DIR, "auth.json"), modelsPath: null });
const { session } = await createAgentSession({
  cwd: process.cwd(),
  agentDir: process.env.PI_CODING_AGENT_DIR,
  modelRuntime,
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(process.cwd()),
  settingsManager: settings,
  tools: [],
});
try {
  await session.bindExtensions({ mode: "tui" });
  if (!session.extensionRunner.getRegisteredCommands().some(command => command.name === "codex-server")) throw new Error("Installed extension did not register its command");
  const owners = await readdir(path.join(process.env.PI_CODEX_APP_SERVER_HOME, "owners"));
  if (owners.filter(file => file.endsWith(".json")).length !== 1) throw new Error("Installed extension did not establish one session owner");
} finally {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
}
const owners = await readdir(path.join(process.env.PI_CODEX_APP_SERVER_HOME, "owners"));
if (owners.some(file => file.endsWith(".json") || file.endsWith(".lock"))) throw new Error("Installed extension did not release its owner and lease");
`
  );
  await run(["node", smoke], workspace);
  const installed = path.join(
    workspace,
    "node_modules",
    ...manifest.name.split("/")
  );
  await Promise.all(
    ["cli", "sidebar-sync", "desktop-sync"].map(async (entry) => {
      await run(
        ["node", path.join(installed, "dist", `${entry}.js`), "--help"],
        workspace
      );
    })
  );
  process.stdout.write(
    `${JSON.stringify({ cleanInstall: "passed", cli: "passed", extension: "passed", files: names.size, migrations: "passed", package: manifest.name, version: manifest.version })}\n`
  );
} finally {
  const relative = path.relative(cache, workspace);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    await rm(workspace, { force: true, recursive: true });
  }
}
