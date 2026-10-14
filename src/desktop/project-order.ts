import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";

import { z } from "zod";

import type { DesktopInventory } from "./sidebar-reconciler.js";

const projectKey = z.string().regex(/^(?:codex|chatgpt):project:.+$/u);
const planSchema = z.strictObject({
  projects: z.array(projectKey),
  sectionId: z.string(),
});
type ProjectOrderPlan = z.infer<typeof planSchema>;

const readPlan = async (
  file: string
): Promise<ProjectOrderPlan | undefined> => {
  try {
    return planSchema.parse(JSON.parse(await readFile(file, "utf-8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw new Error("Invalid pending desktop project order", { cause: error });
  }
};

const savePlan = async (
  file: string,
  plan: ProjectOrderPlan
): Promise<void> => {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(plan), {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
};

export const reconcileDesktopProjectPrefix = async (options: {
  readonly sectionId: string;
  readonly planFile: string;
  readonly readInventory: () => Promise<DesktopInventory>;
  readonly moveProject: (id: string) => Promise<void>;
}): Promise<boolean> => {
  let inventory = await options.readInventory();
  const section = inventory.sections.find(
    (entry) => entry.sectionId === options.sectionId
  );
  if (!section) {
    throw new Error("Configured desktop section is unavailable");
  }
  const projects = section.itemKeys.filter(
    (key) => projectKey.safeParse(key).success
  );
  const saved = await readPlan(options.planFile);
  const previous = saved?.sectionId === options.sectionId ? saved.projects : [];
  const desired = [
    ...previous.filter((key) => projects.includes(key)),
    ...projects.filter((key) => !previous.includes(key)),
  ];
  if (new Set(desired).size !== desired.length) {
    throw new Error("Desktop section contains ambiguous project identities");
  }
  if (desired.every((key, index) => section.itemKeys[index] === key)) {
    await rm(options.planFile, { force: true });
    return false;
  }
  // Persist the original relative order before native moves. A restart must not adopt an intermediate rotation as the target.
  await savePlan(options.planFile, {
    projects: desired,
    sectionId: options.sectionId,
  });
  let changed = false;
  for (let remaining = desired.length; remaining > 0; remaining -= 1) {
    const current = inventory.sections.find(
      (entry) => entry.sectionId === options.sectionId
    );
    if (!current) {
      throw new Error("Configured desktop section is unavailable");
    }
    const currentProjects = current.itemKeys.filter(
      (key) => projectKey.safeParse(key).success
    );
    if (
      currentProjects.length !== desired.length ||
      currentProjects.some((key) => !desired.includes(key))
    ) {
      throw new Error(
        "Desktop project membership changed during ordering; reconcile again"
      );
    }
    // A completed suffix is already at the front after each prepend. Resume after it instead of repeating an uncertain move.
    let placed = desired.length;
    while (
      placed > 0 &&
      !desired
        .slice(desired.length - placed)
        .every((key, index) => current.itemKeys[index] === key)
    ) {
      placed -= 1;
    }
    if (placed === desired.length) {
      break;
    }
    const next = desired[desired.length - placed - 1];
    if (!next) {
      throw new Error("Desktop project order is incomplete");
    }
    // oxlint-disable-next-line no-await-in-loop
    await options.moveProject(next.slice(next.indexOf(":project:") + 9));
    changed = true;
    // oxlint-disable-next-line no-await-in-loop
    inventory = await options.readInventory();
    const confirmed = inventory.sections.find(
      (entry) => entry.sectionId === options.sectionId
    );
    if (confirmed?.itemKeys[0] !== next) {
      throw new Error("Desktop did not confirm project placement");
    }
  }
  const verified = inventory.sections.find(
    (entry) => entry.sectionId === options.sectionId
  );
  if (!desired.every((key, index) => verified?.itemKeys[index] === key)) {
    throw new Error("Desktop did not confirm project prefix");
  }
  await rm(options.planFile, { force: true });
  return changed;
};
