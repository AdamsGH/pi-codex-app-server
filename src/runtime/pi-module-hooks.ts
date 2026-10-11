import type { ResolveHook } from "node:module";

let hostParentUrl: string;

export const initialize = (parentUrl: string): void => {
  hostParentUrl = parentUrl;
};

const hostPackages = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
];

// Pi-managed installs omit peers. The separate daemon can resolve them from
// its launching host without installing another runtime into the extension.
export const resolve: ResolveHook = async (specifier, context, nextResolve) => {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const isHostPackage = hostPackages.some(
      (name) => specifier === name || specifier.startsWith(`${name}/`)
    );
    if (
      !isHostPackage ||
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ERR_MODULE_NOT_FOUND"
    ) {
      throw error;
    }
    return await nextResolve(specifier, {
      ...context,
      parentURL: hostParentUrl,
    });
  }
};
