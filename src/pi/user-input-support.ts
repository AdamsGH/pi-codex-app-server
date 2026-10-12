import type { UserInput } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/UserInput.js";

export const assertSupportedPiInput = (input: readonly UserInput[]): void => {
  if (input.some((part) => part.type === "image" && !("url" in part))) {
    throw new Error(
      "Pi cannot resolve cloud image fileId; provide an image URL or local path"
    );
  }
};
