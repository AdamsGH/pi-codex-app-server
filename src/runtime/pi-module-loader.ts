import { register } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const packageDir = process.env.PI_CODEX_APP_SERVER_PI_PACKAGE_DIR;
if (packageDir) {
  register(new URL("pi-module-hooks.js", import.meta.url), {
    data: pathToFileURL(path.join(packageDir, "package.json")).href,
  });
}
