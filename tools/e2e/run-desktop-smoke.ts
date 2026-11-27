import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CLIENT_DIR,
  cleanupTempDir,
  makeTempDir,
  runFlutterBuild,
  spawnE2eDaemon,
  type SpawnedDaemon,
} from "./lib/harness.ts";

interface DesktopTarget {
  buildTarget: "windows" | "linux" | "macos";
  executablePath: string;
}

function resolveDesktopTarget(): DesktopTarget {
  switch (process.platform) {
    case "win32":
      return {
        buildTarget: "windows",
        executablePath: resolve(
          CLIENT_DIR,
          "build",
          "windows",
          "x64",
          "runner",
          "Release",
          "alfred_client.exe",
        ),
      };
    case "linux":
      return {
        buildTarget: "linux",
        executablePath: resolve(
          CLIENT_DIR,
          "build",
          "linux",
          "x64",
          "release",
          "bundle",
          "alfred_client",
        ),
      };
    case "darwin":
      return {
        buildTarget: "macos",
        executablePath: resolve(
          CLIENT_DIR,
          "build",
          "macos",
          "Build",
          "Products",
          "Release",
          "alfred_client.app",
          "Contents",
          "MacOS",
          "alfred_client",
        ),
      };
    default:
      throw new Error(`Unsupported desktop platform: ${process.platform}`);
  }
}

async function terminateDesktopApp(
  pid: number | undefined,
  child: ReturnType<typeof spawn>,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolveExit) => {
    child.once("exit", () => {
      resolveExit();
    });
  });

  if (process.platform === "win32" && pid !== undefined) {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
  await exited;
}

async function main(): Promise<void> {
  const target = resolveDesktopTarget();
  if (process.env.ALFRED_E2E_SKIP_DESKTOP_BUILD !== "1" || !existsSync(target.executablePath)) {
    process.stdout.write(`▶ Building Flutter Desktop (${target.buildTarget})...\n`);
    runFlutterBuild(target.buildTarget);
  }
  assert.ok(
    existsSync(target.executablePath),
    `Desktop executable not found after build: ${target.executablePath}`,
  );

  const tempDir = makeTempDir("alfred-desktop-smoke-");
  const sqlitePath = join(tempDir, "main.sqlite");
  let daemon: SpawnedDaemon | undefined;
  let desktopProc: ReturnType<typeof spawn> | undefined;

  try {
    daemon = await spawnE2eDaemon({
      ALFRED_E2E_SQLITE_PATH: sqlitePath,
      ALFRED_E2E_MODE: "auto",
      ALFRED_E2E_AUTO_REPLY: "Desktop smoke reply.",
    });

    const daemonUrl = `http://127.0.0.1:${String(daemon.port)}`;
    const healthRes = await fetch(`${daemonUrl}/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = (await healthRes.json()) as {
      ok?: unknown;
      service?: unknown;
      protocolVersion?: unknown;
    };
    assert.equal(healthJson.ok, true);
    assert.equal(healthJson.service, "alfred-daemon");
    assert.equal(healthJson.protocolVersion, 1);

    process.stdout.write(`▶ Launching Desktop executable against ${daemonUrl}...\n`);
    desktopProc = spawn(target.executablePath, [], {
      env: {
        ...process.env,
        ALFRED_DAEMON_URL: daemonUrl,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let desktopStderr = "";
    desktopProc.stderr?.on("data", (chunk: Buffer) => {
      desktopStderr += chunk.toString("utf8");
    });

    const earlyExit = new Promise<never>((_, reject) => {
      desktopProc?.once("exit", (code, signal) => {
        reject(
          new Error(
            `Desktop app exited prematurely (code=${String(code)}, signal=${String(signal)}): ${desktopStderr}`,
          ),
        );
      });
    });

    const subscribed = await Promise.race([
      daemon.waitForEvent((ev) => ev.event === "client_subscribed", 20_000),
      earlyExit,
    ]);
    assert.equal(subscribed.threadId, "main");
    assert.equal(desktopProc.exitCode, null);
    process.stdout.write(
      "✔ Desktop executable built, launched, and completed /ws hello -> snapshot handshake.\n",
    );
  } finally {
    if (desktopProc !== undefined) {
      await terminateDesktopApp(desktopProc.pid, desktopProc);
    }
    if (daemon !== undefined) {
      await daemon.stopGracefully();
    }
    cleanupTempDir(tempDir);
  }
}

await main();
