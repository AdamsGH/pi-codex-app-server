import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { AppServerConfig } from "../src/config/app-server-config.js";
import { appServerLogger } from "../src/logging/app-server-logger.js";
import { JsonRpcConnection } from "../src/protocol/json-rpc-connection.js";
import type { AppServer } from "../src/server/app-server.js";
import { createAppServer } from "../src/server/create-app-server.js";

const directories: string[] = [];
const resultSchema = z.object({
  id: z.literal(2),
  result: z.object({
    data: z.array(
      z.object({
        cwd: z.string(),
        errors: z.array(z.object({ message: z.string(), path: z.string() })),
        skills: z.array(
          z.object({
            enabled: z.boolean(),
            name: z.string(),
            path: z.string(),
            scope: z.string(),
          })
        ),
      })
    ),
  }),
});
const fixture = async () => {
  const home = await mkdtemp(path.join(tmpdir(), "pi-skills-list-"));
  directories.push(home);
  const agentDir = path.join(home, "agent");
  const cwd = path.join(home, "project");
  const userSkill = path.join(agentDir, "skills", "user-skill", "SKILL.md");
  const repoSkill = path.join(cwd, ".pi", "skills", "repo-skill", "SKILL.md");
  await Promise.all([
    mkdir(path.dirname(userSkill), { recursive: true }),
    mkdir(path.dirname(repoSkill), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      userSkill,
      "---\nname: user-skill\ndescription: User skill\n---\nUser instructions\n"
    ),
    writeFile(
      repoSkill,
      "---\nname: repo-skill\ndescription: Repository skill\n---\nRepo instructions\n"
    ),
    writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ defaultProjectTrust: "always" })
    ),
  ]);
  const config: AppServerConfig = {
    autoStart: false,
    hostName: "skills-test",
    listenUrl: new URL("ws://127.0.0.1:0"),
    paths: {
      database: ":memory:",
      endpoint: path.join(home, "endpoint.json"),
      home,
      logs: path.join(home, "logs"),
    },
    piAgentDir: agentDir,
    remoteControl: {
      baseUrl: new URL("https://example.invalid"),
      enabled: false,
    },
  };
  return { agentDir, config, cwd, home, repoSkill, userSkill };
};
const requestSkills = async (
  server: AppServer,
  cwds: string[],
  forceReload = false
) => {
  const sent: string[] = [];
  const connection = new JsonRpcConnection({
    clientId: "skills-test",
    logger: appServerLogger,
    transport: {
      close: () => {},
      read: async function* read() {
        yield JSON.stringify({
          id: 1,
          method: "initialize",
          params: { clientInfo: { name: "skills-test", version: "1" } },
        });
        yield JSON.stringify({
          id: 2,
          method: "skills/list",
          params: { cwds, forceReload },
        });
      },
      send: (message) => {
        sent.push(message);
        return Promise.resolve();
      },
    },
  });
  server.register(connection);
  await connection.run();
  const response = sent
    .map((message) => JSON.parse(message))
    .find((message) => message.id === 2);
  return resultSchema.parse(response).result.data;
};
describe("skills/list", () => {
  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { force: true, recursive: true }))
    );
  });

  it("returns actual Pi user and trusted project skills through the Codex protocol", async () => {
    const f = await fixture();
    const server = await createAppServer(f.config);
    try {
      const entries = await requestSkills(server, [f.cwd]);
      expect(entries).toContainEqual(
        expect.objectContaining({
          cwd: f.cwd,
          skills: expect.arrayContaining([
            {
              enabled: true,
              name: "user-skill",
              path: f.userSkill,
              scope: "user",
            },
            {
              enabled: true,
              name: "repo-skill",
              path: f.repoSkill,
              scope: "repo",
            },
          ]),
        })
      );
    } finally {
      server.close();
    }
  });

  it("honors disabled paths and reloads changes to settings without executing package extensions", async () => {
    const f = await fixture();
    const packageDir = path.join(f.home, "package");
    const packageSkill = path.join(
      packageDir,
      "skills",
      "package-skill",
      "SKILL.md"
    );
    const marker = path.join(f.home, "executed");
    await mkdir(path.dirname(packageSkill), { recursive: true });
    await Promise.all([
      writeFile(
        packageSkill,
        "---\nname: package-skill\ndescription: Package skill\n---\nInstructions\n"
      ),
      writeFile(
        path.join(packageDir, "package.json"),
        JSON.stringify({
          name: "test-pi-package",
          pi: { extensions: ["extension.ts"], skills: ["skills"] },
        })
      ),
      writeFile(
        path.join(packageDir, "extension.ts"),
        `import {writeFileSync} from 'node:fs'; export default function () {writeFileSync(${JSON.stringify(marker)}, 'executed');}`
      ),
    ]);
    const server = await createAppServer(f.config);
    try {
      const initial = await requestSkills(server, [f.cwd]);
      expect(
        initial[0]?.skills.some((skill) => skill.name === "user-skill")
      ).toBeTruthy();
      await writeFile(
        path.join(f.agentDir, "settings.json"),
        JSON.stringify({
          defaultProjectTrust: "never",
          packages: [packageDir],
          skills: ["-skills/user-skill"],
        })
      );
      const reloaded = await requestSkills(server, [f.cwd], true);
      expect(
        reloaded[0]?.skills.some(
          (skill) => skill.name === "user-skill" || skill.name === "repo-skill"
        )
      ).toBeFalsy();
      expect(reloaded[0]?.skills).toContainEqual({
        enabled: true,
        name: "package-skill",
        path: packageSkill,
        scope: "user",
      });
      await expect(stat(marker)).rejects.toThrow("ENOENT");
    } finally {
      server.close();
    }
  });

  it("reports malformed skills and missing packages instead of installing them", async () => {
    const f = await fixture();
    const invalid = path.join(f.agentDir, "skills", "invalid", "SKILL.md");
    await mkdir(path.dirname(invalid), { recursive: true });
    await writeFile(invalid, "---\nname: invalid\n---\nNo description\n");
    await writeFile(
      path.join(f.agentDir, "settings.json"),
      JSON.stringify({ packages: ["npm:@bridge-test/missing-package"] })
    );
    const server = await createAppServer(f.config);
    try {
      const entries = await requestSkills(server, [f.cwd]);
      expect(entries[0]?.errors).toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining("description"),
          path: invalid,
        })
      );
      expect(entries[0]?.errors).toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining("not installed"),
          path: "npm:@bridge-test/missing-package",
        })
      );
    } finally {
      server.close();
    }
  });
});
