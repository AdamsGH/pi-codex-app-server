import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
export const desktopProcessPattern =
  /(?:OpenAI\.Codex[^\r\n]*[\\/]app[\\/]ChatGPT\.exe|[\\/]Codex\.app[\\/]Contents[\\/]MacOS[\\/]|[\\/]codex-desktop(?:[ \r\n]|$)|[\\/]Codex[\\/]codex(?:[ \r\n]|$)|[\\/]Codex[\\/](?:app[\\/])?ChatGPT\.exe)/iu;
export const assertDesktopStopped = async (): Promise<void> => {
  const command =
    process.platform === "win32"
      ? await execute("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process | Select-Object -ExpandProperty ExecutablePath",
        ])
      : await execute("ps", ["-ax", "-o", "command="]);
  if (desktopProcessPattern.test(command.stdout)) {
    throw new Error(
      "Close the Codex desktop app before applying sidebar changes. Dry-run and export can run while it is open."
    );
  }
};
