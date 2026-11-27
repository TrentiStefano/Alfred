import { describe, expect, it, vi } from "vitest";
import { installSignalShutdown, type ShutdownHost } from "../index.ts";

function fakeHost(): ShutdownHost & {
  fire(signal: "SIGINT" | "SIGTERM"): void;
  exits: number[];
  logs: string[];
} {
  const listeners = new Map<string, () => void>();
  const exits: number[] = [];
  const logs: string[] = [];
  return {
    once: (signal, listener) => listeners.set(signal, listener),
    exit: (code) => exits.push(code),
    log: (line) => logs.push(line),
    fire: (signal) => listeners.get(signal)?.(),
    exits,
    logs,
  };
}

describe("installSignalShutdown", () => {
  it("closes once and then exits 0, even if both signals arrive", async () => {
    const host = fakeHost();
    const close = vi.fn(() => Promise.resolve());
    const onSignal = vi.fn();
    installSignalShutdown({ close, onSignal, host });

    host.fire("SIGTERM");
    host.fire("SIGINT");
    await vi.waitFor(() => {
      expect(host.exits).toEqual([0]);
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(onSignal).toHaveBeenCalledWith("SIGTERM");
  });

  it("exits 1 and logs when close() rejects", async () => {
    const host = fakeHost();
    installSignalShutdown({ close: () => Promise.reject(new Error("boom")), host });

    host.fire("SIGTERM");
    await vi.waitFor(() => {
      expect(host.exits).toEqual([1]);
    });
    expect(host.logs.join("\n")).toContain("boom");
  });

  it("forces exit 1 when close() hangs past the deadline", async () => {
    vi.useFakeTimers();
    try {
      const host = fakeHost();
      installSignalShutdown({
        close: () => new Promise<void>(() => undefined),
        forceExitAfterMs: 1_000,
        host,
      });

      host.fire("SIGINT");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(host.exits).toEqual([1]);
      expect(host.logs.join("\n")).toContain("did not finish");
    } finally {
      vi.useRealTimers();
    }
  });
});
