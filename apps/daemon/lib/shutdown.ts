/** What a signal-driven shutdown needs from the host process (injectable for tests). */
export interface ShutdownHost {
  once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  exit(code: number): void;
  log(line: string): void;
}

export interface SignalShutdownOptions {
  /** Closes the server and the Agent runtime. */
  close(): Promise<void>;
  /** Called once per signal before closing (e.g. to emit a structured event). */
  onSignal?(signal: string): void;
  /** Force exit after this long if `close()` hangs. */
  forceExitAfterMs?: number;
  host?: ShutdownHost;
}

const DEFAULT_FORCE_EXIT_MS = 5_000;

const processHost: ShutdownHost = {
  once: (signal, listener) => process.once(signal, listener),
  exit: (code) => process.exit(code),
  log: (line) => process.stderr.write(`${line}\n`),
};

/**
 * On SIGINT/SIGTERM, close everything once and then exit explicitly.
 *
 * Exiting explicitly matters: open handles (a stdin reader, Pi Durable timers, keep-alive
 * sockets) would otherwise keep the event loop alive after a graceful close, so the process
 * would never terminate on Linux, where SIGTERM runs this handler instead of killing outright.
 */
export function installSignalShutdown(options: SignalShutdownOptions): void {
  const host = options.host ?? processHost;
  const forceExitAfterMs = options.forceExitAfterMs ?? DEFAULT_FORCE_EXIT_MS;
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    options.onSignal?.(signal);
    const forceExit = setTimeout(() => {
      host.log(`alfred-daemon: close() did not finish within ${String(forceExitAfterMs)}ms`);
      host.exit(1);
    }, forceExitAfterMs);
    forceExit.unref();
    let code = 0;
    try {
      await options.close();
    } catch (error) {
      host.log(
        `alfred-daemon shutdown error: ${error instanceof Error ? error.message : String(error)}`,
      );
      code = 1;
    }
    clearTimeout(forceExit);
    host.exit(code);
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    host.once(signal, () => {
      void shutdown(signal);
    });
  }
}
