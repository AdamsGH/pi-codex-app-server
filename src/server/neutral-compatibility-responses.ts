import type { JsonRpcConnection } from "../protocol/json-rpc-connection.js";

export const registerNeutralCompatibilityResponses = (
  connection: JsonRpcConnection
): void => {
  connection.registerRequest("configRequirements/read", () => ({
    requirements: null,
    supportsIndependentSpeedModes: false,
  }));
  connection.registerRequest("plugin/installed", () => ({
    marketplaceLoadErrors: [],
    marketplaces: [],
  }));
  connection.registerRequest("plugin/list", () => ({
    featuredPluginIds: [],
    marketplaceLoadErrors: [],
    marketplaces: [],
  }));
  connection.registerRequest("app/list", () => ({
    data: [],
    nextCursor: null,
  }));
  connection.registerRequest("app/installed", () => ({ apps: [] }));
  connection.registerRequest("collaborationMode/list", () => ({ data: [] }));
  connection.registerRequest("permissionProfile/list", () => ({
    data: [],
    nextCursor: null,
  }));
  connection.registerRequest("thread/goal/get", () => ({ goal: null }));
  connection.registerRequest("experimentalFeature/list", () => ({
    data: [],
    nextCursor: null,
  }));
  connection.registerRequest("hooks/list", () => ({ data: [] }));
  connection.registerRequest("mcpServerStatus/list", () => ({
    data: [],
    nextCursor: null,
  }));
  connection.registerRequest("thread/queue/list", () => ({
    data: [],
    nextCursor: null,
  }));
};
