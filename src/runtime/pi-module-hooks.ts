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

// Use the launching host's SDK even when extension development dependencies
// are installed. Mixing versions changes model and session contracts.
export const resolve: ResolveHook = async (specifier, context, nextResolve) => {
  const isHostPackage = hostPackages.some(
    (name) => specifier === name || specifier.startsWith(`${name}/`)
  );
  return await nextResolve(
    specifier,
    isHostPackage
      ? {
          ...context,
          parentURL: hostParentUrl,
        }
      : context
  );
};
