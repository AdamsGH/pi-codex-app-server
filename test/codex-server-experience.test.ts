import { describe, expect, it, vi } from "vitest";

import { createCodexServerExperience } from "../src/extension/codex-server-experience.js";
import type {
  CodexServerContext,
  CodexServerControl,
} from "../src/extension/codex-server-experience.js";
import type { DaemonStatus } from "../src/extension/daemon-controller.js";

const runningStatus = {
  endpoint: {
    pid: 4242,
    startedAt: "2026-08-24T00:00:00.000Z",
    transport: "websocket",
    url: "ws://127.0.0.1:4242/",
  },
  state: "running",
} satisfies DaemonStatus;

const createContext = () => {
  const notify = vi.fn<CodexServerContext["notify"]>();
  const showPairing = vi.fn<CodexServerContext["showPairing"]>();
  const setStatus = vi.fn<CodexServerContext["setStatus"]>();
  return {
    context: {
      hasUi: true,
      notify,
      sessionId: "pi-session-1",
      setStatus,
      showPairing,
    } satisfies CodexServerContext,
    notify,
    setStatus,
    showPairing,
  };
};

const createControl = (): CodexServerControl => ({
  pair: vi.fn<CodexServerControl["pair"]>().mockResolvedValue({
    expiresAt: "2026-08-24T00:10:00.000Z",
    manualPairingCode: "ABCD-EFGH",
    pairingCode: "opaque-pairing-payload",
  }),
  start: vi.fn<CodexServerControl["start"]>().mockResolvedValue(runningStatus),
  status: vi
    .fn<CodexServerControl["status"]>()
    .mockResolvedValue(runningStatus),
  stop: vi
    .fn<CodexServerControl["stop"]>()
    .mockResolvedValue({ state: "stopped" }),
});

const createQrRenderer = () => vi.fn<(payload: string) => Promise<string>>();

describe("Codex Server extension experience", () => {
  it("offers every subcommand as argument completions", () => {
    const experience = createCodexServerExperience({
      autoStart: true,
      control: createControl(),
      paths: {
        endpoint: "C:/pi/codex-app-server/endpoint.json",
        logs: "C:/pi/codex-app-server/logs",
      },
      remoteControlEnabled: true,
      renderQrCode: createQrRenderer(),
    });

    expect(experience.getArgumentCompletions("st")).toStrictEqual([
      {
        description: "Start the background daemon",
        label: "start",
        value: "start",
      },
      {
        description: "Stop the background daemon",
        label: "stop",
        value: "stop",
      },
      {
        description: "Show daemon and session details",
        label: "status",
        value: "status",
      },
    ]);
  });

  it("starts the daemon on Pi session startup and displays footer status", async () => {
    const control = createControl();
    const { context, setStatus } = createContext();
    const experience = createCodexServerExperience({
      autoStart: true,
      control,
      paths: { endpoint: "endpoint.json", logs: "logs" },
      remoteControlEnabled: true,
      renderQrCode: createQrRenderer(),
    });

    await experience.handleSessionStart(context);

    expect(control.start).toHaveBeenCalledOnce();
    expect(setStatus).toHaveBeenCalledWith("codex-server", "codex: connected");
  });

  it("shows detailed daemon status", async () => {
    const { context, notify, setStatus } = createContext();
    const experience = createCodexServerExperience({
      autoStart: true,
      control: createControl(),
      paths: { endpoint: "endpoint.json", logs: "logs" },
      remoteControlEnabled: true,
      renderQrCode: createQrRenderer(),
    });

    await experience.handleCommand("status", context);

    expect(setStatus).toHaveBeenCalledWith("codex-server", "codex: connected");
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining(
        "Codex App Server: running\nPID: 4242\nWebSocket: ws://127.0.0.1:4242/"
      ),
      "info"
    );
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Current Pi session: pi-session-1"),
      "info"
    );
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining(
        "codex --remote 'ws://127.0.0.1:4242/' resume 'pi-session-1'"
      ),
      "info"
    );
  });

  it("shows a compact disconnected footer after stopping the daemon", async () => {
    const { context, setStatus } = createContext();
    const experience = createCodexServerExperience({
      autoStart: false,
      control: createControl(),
      paths: { endpoint: "endpoint.json", logs: "logs" },
      remoteControlEnabled: true,
      renderQrCode: createQrRenderer(),
    });

    await experience.handleCommand("stop", context);

    expect(setStatus).toHaveBeenCalledWith(
      "codex-server",
      "codex: disconnected"
    );
  });

  it("shows a compact disconnected footer when daemon startup fails", async () => {
    const { context, setStatus } = createContext();
    const control = createControl();
    vi.mocked(control.start).mockRejectedValue(new Error("Unavailable"));
    const experience = createCodexServerExperience({
      autoStart: true,
      control,
      paths: { endpoint: "endpoint.json", logs: "logs" },
      remoteControlEnabled: true,
      renderQrCode: createQrRenderer(),
    });

    await experience.handleSessionStart(context);

    expect(setStatus).toHaveBeenCalledWith(
      "codex-server",
      "codex: disconnected (server unavailable)"
    );
  });

  it("shows QR and manual pairing options in an overlay", async () => {
    const { context, showPairing } = createContext();
    const renderQrCode = createQrRenderer().mockResolvedValue(
      "QR-LINE-1\nQR-LINE-2"
    );
    const experience = createCodexServerExperience({
      autoStart: true,
      control: createControl(),
      paths: { endpoint: "endpoint.json", logs: "logs" },
      remoteControlEnabled: true,
      renderQrCode,
    });

    await experience.handleCommand("pair", context);

    expect(renderQrCode).toHaveBeenCalledWith("opaque-pairing-payload");
    expect(showPairing).toHaveBeenCalledWith({
      compactLines: [
        "Terminal is too small to display the QR code.",
        "Manual code: ABCD-EFGH",
        "Expires: 2026-08-24T00:10:00.000Z",
        "Press Enter or Esc to close",
      ],
      fullLines: [
        "Scan with ChatGPT to pair:",
        "QR-LINE-1",
        "QR-LINE-2",
        "Manual code: ABCD-EFGH",
        "Expires: 2026-08-24T00:10:00.000Z",
        "Press Enter or Esc to close",
      ],
    });
  });
});
