import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const PIPE_PREFIX = "\\\\.\\pipe\\codex-browser-use-";
const DISCOVERY_TIMEOUT_MS = 15_000;

// Match the pipe owner to the installed package, not just an executable name.
const WINDOWS_DISCOVERY = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PiCodexDesktopPipe {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll")] public static extern bool GetNamedPipeServerProcessId(IntPtr handle, out uint processId);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
'@
$desktopExecutables = @()
foreach ($package in @(Get-AppxPackage -Name OpenAI.Codex)) {
  foreach ($name in @('ChatGPT.exe', 'Codex.exe')) {
    $desktopExecutables += Join-Path $package.InstallLocation ('app\' + $name)
  }
}
function Test-DesktopPipe([string] $pipePath) {
  $handle = [PiCodexDesktopPipe]::CreateFile($pipePath, 0, 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
  if ($handle -eq [IntPtr](-1)) { return $false }
  try {
    $ownerId = [uint32]0
    if (-not [PiCodexDesktopPipe]::GetNamedPipeServerProcessId($handle, [ref]$ownerId)) { return $false }
    $owner = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $ownerId) -ErrorAction SilentlyContinue
    if ($null -eq $owner -or [string]::IsNullOrWhiteSpace($owner.CommandLine)) { return $false }
    if ($owner.CommandLine -match '(?:^|\s)--type(?:=|\s)') { return $false }
    return $desktopExecutables -contains $owner.ExecutablePath
  } finally {
    [void][PiCodexDesktopPipe]::CloseHandle($handle)
  }
}
$preferred = $env:PI_CODEX_DESKTOP_PREFERRED_ENDPOINT
if ($preferred -and (Test-DesktopPipe $preferred)) {
  ConvertTo-Json -InputObject @($preferred) -Compress
  exit 0
}
$matches = @()
foreach ($pipe in @(Get-ChildItem -LiteralPath '\\.\pipe\' | Where-Object Name -Like 'codex-browser-use-*')) {
  $pipePath = '\\.\pipe\' + $pipe.Name
  if (Test-DesktopPipe $pipePath) { $matches += $pipePath }
}
ConvertTo-Json -InputObject @($matches) -Compress
`;

const discoverWindowsEndpoints = async (
  preferred: string | undefined
): Promise<string> => {
  const { stdout } = await execute(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(WINDOWS_DISCOVERY, "utf16le").toString("base64"),
    ],
    {
      env: {
        ...process.env,
        PI_CODEX_DESKTOP_PREFERRED_ENDPOINT: preferred ?? "",
      },
      maxBuffer: 64 * 1024,
      timeout: DISCOVERY_TIMEOUT_MS,
      windowsHide: true,
    }
  );
  return stdout;
};

export interface DesktopEndpointDiscovery {
  platform: string;
  discover: (preferred: string | undefined) => Promise<string>;
}

const runtimeDiscovery: DesktopEndpointDiscovery = {
  discover: discoverWindowsEndpoints,
  platform: process.platform,
};

export const resolveDesktopEndpoint = async (
  preferred: string | undefined,
  discovery: DesktopEndpointDiscovery = runtimeDiscovery
): Promise<string> => {
  if (discovery.platform !== "win32") {
    if (!preferred) {
      throw new Error(
        "Desktop native tools require an explicit endpoint on this platform"
      );
    }
    return preferred;
  }
  if (preferred && !preferred.startsWith(PIPE_PREFIX)) {
    throw new Error(
      "Desktop native tools endpoint is not a Codex app-tools named pipe"
    );
  }
  let stdout: string;
  try {
    stdout = await discovery.discover(preferred);
  } catch {
    throw new Error(
      "Could not verify the running Codex desktop app-tools endpoint"
    );
  }
  let endpoints: unknown;
  try {
    endpoints = JSON.parse(stdout);
  } catch {
    throw new Error("Invalid Codex desktop endpoint discovery result");
  }
  if (
    !Array.isArray(endpoints) ||
    !endpoints.every(
      (endpoint): endpoint is string =>
        typeof endpoint === "string" && endpoint.startsWith(PIPE_PREFIX)
    )
  ) {
    throw new Error("Invalid Codex desktop endpoint discovery result");
  }
  const unique = [...new Set<string>(endpoints)];
  const [endpoint] = unique;
  if (unique.length !== 1 || endpoint === undefined) {
    throw new Error(
      unique.length === 0
        ? "No verified Codex desktop app-tools endpoint is available"
        : "Multiple Codex desktop app-tools endpoints are available; select an explicit endpoint"
    );
  }
  return endpoint;
};
