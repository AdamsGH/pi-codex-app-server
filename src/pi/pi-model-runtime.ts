import path from "node:path";

import {
  ModelRegistry,
  ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import type { GetAuthStatusParams } from "../../vendor/openai-codex-app-server-protocol/typescript/GetAuthStatusParams.js";
import type { GetAuthStatusResponse } from "../../vendor/openai-codex-app-server-protocol/typescript/GetAuthStatusResponse.js";
import type { AppServerConfig } from "../config/app-server-config.js";

export const OPENAI_CODEX_PROVIDER = "openai-codex";

export class PiModelRuntime {
  readonly modelRegistry: ModelRegistry;
  readonly modelRuntime: ModelRuntime;
  readonly settings: SettingsManager;

  private constructor(modelRuntime: ModelRuntime, settings: SettingsManager) {
    this.modelRuntime = modelRuntime;
    this.modelRegistry = new ModelRegistry(modelRuntime);
    this.settings = settings;
  }

  static async create(config: AppServerConfig): Promise<PiModelRuntime> {
    const modelRuntime = await ModelRuntime.create({
      allowModelNetwork: false,
      authPath: path.join(config.piAgentDir, "auth.json"),
      modelsPath: path.join(config.piAgentDir, "models.json"),
      refreshOnCreate: true,
    });
    return new PiModelRuntime(
      modelRuntime,
      SettingsManager.create(process.cwd(), config.piAgentDir)
    );
  }

  hasOpenAiAuthentication(): boolean {
    return this.modelRuntime.getProviderAuthStatus(OPENAI_CODEX_PROVIDER)
      .configured;
  }

  async readAuthStatus(
    params: GetAuthStatusParams,
    signal?: AbortSignal
  ): Promise<GetAuthStatusResponse> {
    const auth =
      params.includeToken || params.refreshToken
        ? await this.modelRuntime.getAuth(OPENAI_CODEX_PROVIDER, { signal })
        : undefined;
    const configured = this.hasOpenAiAuthentication();
    let authMethod: GetAuthStatusResponse["authMethod"] = null;
    if (configured) {
      authMethod = this.modelRuntime.isUsingOAuth(OPENAI_CODEX_PROVIDER)
        ? "chatgpt"
        : "apikey";
    }
    return {
      authMethod,
      authToken: params.includeToken ? (auth?.auth.apiKey ?? null) : null,
      requiresOpenaiAuth: false,
    };
  }

  async refreshModels(signal?: AbortSignal): Promise<void> {
    await this.settings.reload();
    await this.modelRuntime.refresh({ allowNetwork: false, signal });
  }

  async logoutOpenAi(signal?: AbortSignal): Promise<void> {
    await this.modelRuntime.logout(OPENAI_CODEX_PROVIDER, { signal });
  }
}
