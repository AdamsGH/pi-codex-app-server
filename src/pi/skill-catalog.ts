import path from "node:path";

import {
  DefaultPackageManager,
  SettingsManager,
  ProjectTrustStore,
  hasTrustRequiringProjectResources,
  loadSkills,
} from "@earendil-works/pi-coding-agent";

import type { SkillsListEntry } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/SkillsListEntry.js";
import type { SkillsListParams } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/SkillsListParams.js";
import type { SkillsListResponse } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/SkillsListResponse.js";

export const listPiSkills = async (
  agentDir: string,
  params: SkillsListParams,
  defaultCwd: string
): Promise<SkillsListResponse> => {
  const cwds = [
    ...new Set(
      (params.cwds?.length ? params.cwds : [defaultCwd]).map((cwd) =>
        path.resolve(cwd)
      )
    ),
  ];
  const data = await Promise.all(
    cwds.map(async (cwd): Promise<SkillsListEntry> => {
      try {
        const settings = SettingsManager.create(cwd, agentDir);
        const trusted =
          new ProjectTrustStore(agentDir).get(cwd) ??
          (!hasTrustRequiringProjectResources(cwd) ||
            settings.getDefaultProjectTrust() === "always");
        settings.setProjectTrusted(trusted);
        await settings.reload();
        const packages = new DefaultPackageManager({
          agentDir,
          cwd,
          settingsManager: settings,
        });
        const missing: string[] = [];
        const resources = await packages.resolve((source) => {
          missing.push(source);
          // eslint-disable-next-line promise/no-return-wrap -- Pi requires a promise-returning missing-source callback.
          return Promise.resolve("skip");
        });
        const enabled = resources.skills.filter((resource) => resource.enabled);
        const { skills, diagnostics } = loadSkills({
          agentDir,
          cwd,
          includeDefaults: false,
          skillPaths: enabled.map((resource) => resource.path),
        });
        return {
          cwd,
          errors: [
            ...diagnostics
              .filter((diagnostic) => diagnostic.type !== "collision")
              .map((diagnostic) => ({
                message: diagnostic.message,
                path: diagnostic.path ?? cwd,
              })),
            ...missing.map((source) => ({
              message: `Pi package is not installed: ${source}`,
              path: source,
            })),
          ],
          skills: skills.map((skill) => {
            const resource = enabled.find((entry) => {
              const relative = path.relative(entry.path, skill.filePath);
              return (
                relative === "" ||
                (!path.isAbsolute(relative) &&
                  relative !== ".." &&
                  !relative.startsWith(`..${path.sep}`))
              );
            });
            return {
              description: skill.description,
              enabled: true,
              name: skill.name,
              path: path.resolve(skill.filePath),
              scope: resource?.metadata.scope === "project" ? "repo" : "user",
            };
          }),
        };
      } catch (error) {
        return {
          cwd,
          errors: [
            {
              message:
                error instanceof Error
                  ? error.message
                  : "Could not discover Pi skills",
              path: cwd,
            },
          ],
          skills: [],
        };
      }
    })
  );
  return { data };
};
