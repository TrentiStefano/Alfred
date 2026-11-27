import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const DAEMON_E2E_SCRIPT = resolve(REPO_ROOT, "apps", "daemon", "e2e-daemon.ts");
export const CLIENT_DIR = resolve(REPO_ROOT, "apps", "client");
export const WEB_BUILD_DIR = resolve(CLIENT_DIR, "build", "web");

/** Inputs whose changes make a compiled Flutter Web bundle out of date. */
const WEB_BUILD_INPUTS = [join(CLIENT_DIR, "lib"), join(CLIENT_DIR, "web")];
const WEB_BUILD_INPUT_FILES = [join(CLIENT_DIR, "pubspec.yaml"), join(CLIENT_DIR, "pubspec.lock")];

function newestMtimeMs(path: string): number {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = 0;
  for (const entry of readdirSync(path)) {
    newest = Math.max(newest, newestMtimeMs(join(path, entry)));
  }
  return newest;
}

/**
 * True when `build/web/index.html` is missing or older than any client source, so E2E never
 * runs against a stale bundle (which shows up as a misleading connection timeout).
 */
export function isWebBuildStale(webBuildDir = WEB_BUILD_DIR): boolean {
  const indexHtml = join(webBuildDir, "index.html");
  if (!existsSync(indexHtml)) return true;
  const builtAt = statSync(indexHtml).mtimeMs;
  const sourcesAt = Math.max(...[...WEB_BUILD_INPUTS, ...WEB_BUILD_INPUT_FILES].map(newestMtimeMs));
  return sourcesAt > builtAt;
}

export interface DaemonEvent {
  event: string;
  port?: number;
  host?: string;
  callCount?: number;
  prompt?: string;
  threadId?: string;
  seq?: number;
}

export interface SpawnedDaemon {
  process: ChildProcess;
  port: number;
  sendCommand(cmd: Record<string, unknown>): void;
  waitForEvent(predicate: (ev: DaemonEvent) => boolean, timeoutMs?: number): Promise<DaemonEvent>;
  killSigkill(): Promise<void>;
  stopGracefully(): Promise<void>;
}

interface PendingWaiter {
  predicate: (ev: DaemonEvent) => boolean;
  resolve: (ev: DaemonEvent) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Create a temporary directory under the OS temp folder for isolated E2E SQLite state. */
export function makeTempDir(prefix = "alfred-e2e-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Remove a temporary directory recursively, ignoring missing files. */
export function cleanupTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Spawn the real daemon entry point (`apps/daemon/e2e-daemon.ts`) as a child process. */
export async function spawnE2eDaemon(envOverrides: Record<string, string>): Promise<SpawnedDaemon> {
  const child = spawn(process.execPath, [DAEMON_E2E_SCRIPT], {
    env: {
      ...process.env,
      ALFRED_DAEMON_HOST: "127.0.0.1",
      ALFRED_DAEMON_PORT: "0",
      ...envOverrides,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const events: DaemonEvent[] = [];
  const waiters: PendingWaiter[] = [];
  let stderrBuffer = "";
  let exited = false;
  let exitSummary = "";

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });

  function rejectAllWaiters(error: Error): void {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      return;
    }
    const parsed = JSON.parse(trimmed) as DaemonEvent;
    const waiterIndex = waiters.findIndex((w) => w.predicate(parsed));
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1);
      if (waiter !== undefined) {
        clearTimeout(waiter.timer);
        waiter.resolve(parsed);
      }
      return;
    }
    events.push(parsed);
  });

  child.stderr.on("data", (chunk: Buffer) => {
    stderrBuffer += chunk.toString("utf8");
  });

  child.once("exit", (code, signal) => {
    exited = true;
    exitSummary = `code=${String(code)} signal=${String(signal)} stderr=${stderrBuffer}`;
    rl.close();
    rejectAllWaiters(new Error(`e2e-daemon exited (${exitSummary})`));
  });

  function waitForEvent(
    predicate: (ev: DaemonEvent) => boolean,
    timeoutMs = 15_000,
  ): Promise<DaemonEvent> {
    const existingIndex = events.findIndex(predicate);
    if (existingIndex >= 0) {
      const [matched] = events.splice(existingIndex, 1);
      if (matched !== undefined) {
        return Promise.resolve(matched);
      }
    }
    if (exited) {
      return Promise.reject(new Error(`e2e-daemon already exited (${exitSummary})`));
    }
    return new Promise<DaemonEvent>((resolveEvent, rejectEvent) => {
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.resolve === resolveEvent);
        if (idx >= 0) {
          waiters.splice(idx, 1);
        }
        rejectEvent(
          new Error(
            `Timed out after ${String(timeoutMs)}ms waiting for daemon event. ${stderrBuffer}`,
          ),
        );
      }, timeoutMs);
      waiters.push({ predicate, resolve: resolveEvent, reject: rejectEvent, timer });
    });
  }

  const listening = await waitForEvent((ev) => ev.event === "listening", 15_000);
  if (listening.port === undefined) {
    throw new Error(`Listening event missing port: ${JSON.stringify(listening)}`);
  }

  function waitForProcessExit(): Promise<void> {
    if (exited || child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve();
    }
    return new Promise<void>((resolveExit) => {
      child.once("exit", () => {
        resolveExit();
      });
    });
  }

  return {
    process: child,
    port: listening.port,
    sendCommand: (cmd) => {
      child.stdin.write(`${JSON.stringify(cmd)}\n`);
    },
    waitForEvent,
    killSigkill: async () => {
      if (exited) {
        return;
      }
      const exiting = waitForProcessExit();
      child.kill("SIGKILL");
      await exiting;
    },
    stopGracefully: async () => {
      if (exited || child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      const exiting = waitForProcessExit();
      child.kill("SIGTERM");
      await exiting;
    },
  };
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export interface StaticWebServer {
  port: number;
  close(): Promise<void>;
}

/** Serve a built Flutter Web output directory over localhost HTTP. */
export async function startStaticWebServer(rootDir = WEB_BUILD_DIR): Promise<StaticWebServer> {
  const normalizedRoot = resolve(rootDir);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const relativePath =
      reqUrl.pathname === "/" ? "index.html" : reqUrl.pathname.replace(/^\/+/, "");
    const candidate = resolve(normalizedRoot, relativePath);

    if (candidate !== normalizedRoot && !candidate.startsWith(`${normalizedRoot}${sep}`)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    const filePath =
      existsSync(candidate) && statSync(candidate).isFile()
        ? candidate
        : resolve(normalizedRoot, "index.html");

    if (!existsSync(filePath)) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    const mime = MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": mime });
    res.end(readFileSync(filePath));
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  const addr = server.address() as AddressInfo;
  return {
    port: addr.port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((err) => {
          if (err !== undefined) {
            rejectClose(err);
          } else {
            resolveClose();
          }
        });
      });
    },
  };
}

/** Run `flutter build <target>` inside `apps/client`. */
export function runFlutterBuild(target: "web" | "windows" | "linux" | "macos"): void {
  const command = `flutter build ${target}`;
  let buildCwd = CLIENT_DIR;
  let junctionDir: string | undefined;

  // Windows MSBuild FileTracker fails when deep worktree paths push CMakeScratch .tlog paths past MAX_PATH (260).
  if (target === "windows" && process.platform === "win32" && CLIENT_DIR.length > 95) {
    const partialWinBuild = join(CLIENT_DIR, "build", "windows");
    if (existsSync(partialWinBuild)) {
      rmSync(partialWinBuild, { recursive: true, force: true });
    }
    const candidate = join(tmpdir(), `alfred-win-${String(process.pid)}`);
    if (existsSync(candidate)) {
      spawnSync("cmd", ["/c", "rmdir", candidate], { stdio: "ignore" });
    }
    const mk = spawnSync("cmd", ["/c", "mklink", "/J", candidate, CLIENT_DIR], {
      stdio: "inherit",
    });
    if (mk.status === 0) {
      junctionDir = candidate;
      buildCwd = candidate;
    }
  }

  try {
    const result = spawnSync(command, {
      cwd: buildCwd,
      stdio: "inherit",
      shell: true,
    });
    if (result.status !== 0) {
      throw new Error(`"${command}" failed with exit code ${String(result.status)}.`);
    }
  } finally {
    if (junctionDir !== undefined) {
      spawnSync("cmd", ["/c", "rmdir", junctionDir], { stdio: "ignore" });
    }
  }
}

/** Launch headless Chromium (using installed Playwright Chromium or falling back to system Chrome). */
export async function launchPlaywrightBrowser(): Promise<Browser> {
  const customPath = process.env.ALFRED_E2E_CHROME_PATH?.trim();
  if (customPath !== undefined && customPath.length > 0) {
    return chromium.launch({ headless: true, executablePath: customPath });
  }
  const bundledPath = chromium.executablePath();
  if (existsSync(bundledPath)) {
    return chromium.launch({ headless: true });
  }
  return chromium.launch({ headless: true, channel: "chrome" });
}
