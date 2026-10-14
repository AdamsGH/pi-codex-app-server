import { chmod } from "node:fs/promises";
import path from "node:path";

import { verifyProtocolSnapshot } from "./protocol-snapshot.js";

const root = path.resolve(import.meta.dir, "..");
await verifyProtocolSnapshot(
  path.join(root, "vendor/openai-codex-app-server-protocol")
);
const sharedOptions = {
  format: "esm",
  packages: "external",
  sourcemap: "external",
  target: "node",
} satisfies Pick<
  Bun.BuildConfig,
  "format" | "packages" | "sourcemap" | "target"
>;

const libraryBuild = await Bun.build({
  ...sharedOptions,
  entrypoints: [
    path.resolve(root, "src/index.ts"),
    path.resolve(root, "src/extension/index.ts"),
    path.resolve(root, "src/runtime/pi-module-loader.ts"),
    path.resolve(root, "src/runtime/pi-module-hooks.ts"),
    path.resolve(root, "src/desktop/native-tools.ts"),
  ],
  naming: "[dir]/[name].[ext]",
  outdir: path.resolve(root, "dist"),
  root: path.resolve(root, "src"),
});

const cliBuild = await Bun.build({
  ...sharedOptions,
  banner: "#!/usr/bin/env node",
  entrypoints: [
    path.resolve(root, "src/cli.ts"),
    path.resolve(root, "src/sidebar-sync.ts"),
    path.resolve(root, "src/desktop-sync.ts"),
  ],
  outdir: path.resolve(root, "dist"),
});

const failures = [...libraryBuild.logs, ...cliBuild.logs].filter(
  (message) => message.level === "error"
);
if (!libraryBuild.success || !cliBuild.success || failures.length > 0) {
  for (const failure of failures) {
    process.stderr.write(`${failure.message}\n`);
  }
  process.exitCode = 1;
} else {
  await chmod(path.resolve(root, "dist/cli.js"), 0o755);
}
