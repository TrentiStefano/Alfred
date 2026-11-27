import assert from "node:assert/strict";
import { join } from "node:path";
import type { Browser, Page } from "playwright";
import { WebSocket } from "ws";
import {
  DEFAULT_MAIN_THREAD_ID,
  createHelloMessage,
  createSubmitMessage,
  parseDaemonMessage,
  type DaemonMessage,
  type SnapshotMessage,
} from "@alfred/protocol";
import {
  WEB_BUILD_DIR,
  isWebBuildStale,
  cleanupTempDir,
  launchPlaywrightBrowser,
  makeTempDir,
  runFlutterBuild,
  spawnE2eDaemon,
  startStaticWebServer,
  type SpawnedDaemon,
  type StaticWebServer,
} from "./harness.ts";

interface ViewportProfile {
  name: string;
  width: number;
  height: number;
  isMobile: boolean;
  hasTouch: boolean;
}

const VIEWPORTS: readonly ViewportProfile[] = [
  { name: "desktop", width: 1280, height: 800, isMobile: false, hasTouch: false },
  { name: "iphone", width: 390, height: 844, isMobile: true, hasTouch: true },
];

function statusLocator(page: Page, statusLabel: string) {
  return page
    .locator("flt-semantics-host")
    .getByText(`Connection status: ${statusLabel}`, { exact: true });
}

function ownerMessageCount(page: Page): Promise<number> {
  return page
    .locator("flt-semantics > span")
    .filter({ hasText: /^Owner \(/ })
    .count();
}

async function submitPromptInUi(page: Page, prompt: string): Promise<void> {
  const textbox = page.getByRole("textbox").first();
  await textbox.waitFor({ state: "visible", timeout: 15_000 });
  await textbox.click();
  await textbox.fill(prompt);
  const sendButton = page.getByRole("button", { name: "Send" });
  await sendButton.waitFor({ state: "visible", timeout: 10_000 });
  await sendButton.click();
}

async function replayRequestOverWs(
  port: number,
  expectedText: string,
): Promise<{ deduplicated: boolean }> {
  const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
  const inbox: DaemonMessage[] = [];
  const waiters: ((msg: DaemonMessage) => void)[] = [];

  ws.on("message", (data) => {
    const raw =
      typeof data === "string"
        ? data
        : Buffer.isBuffer(data)
          ? data.toString("utf8")
          : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]).toString("utf8");
    const parsed = parseDaemonMessage(JSON.parse(raw));
    const waiter = waiters.shift();
    if (waiter !== undefined) {
      waiter(parsed);
    } else {
      inbox.push(parsed);
    }
  });

  function nextMessage(): Promise<DaemonMessage> {
    const queued = inbox.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    return new Promise<DaemonMessage>((resolve) => {
      waiters.push(resolve);
    });
  }

  try {
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => {
        resolve();
      });
      ws.once("error", reject);
    });

    ws.send(JSON.stringify(createHelloMessage()));
    const snapMsg = await nextMessage();
    assert.equal(snapMsg.type, "snapshot");
    const snapshot: SnapshotMessage = snapMsg;
    const ownerTurn = snapshot.thread.messages.find(
      (msg) => msg.role === "owner" && msg.text === expectedText,
    );
    assert.ok(ownerTurn?.requestId, `Expected owner turn "${expectedText}" with requestId`);

    ws.send(
      JSON.stringify(
        createSubmitMessage({
          threadId: DEFAULT_MAIN_THREAD_ID,
          requestId: ownerTurn.requestId,
          text: expectedText,
        }),
      ),
    );

    const ackMsg = await nextMessage();
    assert.equal(ackMsg.type, "ack");
    assert.equal(ackMsg.requestId, ownerTurn.requestId);
    return { deduplicated: ackMsg.deduplicated === true };
  } finally {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      await new Promise<void>((resolve) => {
        ws.once("close", () => {
          resolve();
        });
        ws.close();
      });
    }
  }
}

async function runViewportScenario(
  browser: Browser,
  webPort: number,
  profile: ViewportProfile,
): Promise<void> {
  process.stdout.write(
    `\n▶ Running Playwright E2E (${profile.name} ${String(profile.width)}x${String(profile.height)})\n`,
  );
  const tempDir = makeTempDir(`alfred-e2e-${profile.name}-`);
  const sqlitePath = join(tempDir, "main.sqlite");

  let daemon1: SpawnedDaemon | undefined;
  let daemon2: SpawnedDaemon | undefined;

  const context = await browser.newContext({
    viewport: { width: profile.width, height: profile.height },
    isMobile: profile.isMobile,
    hasTouch: profile.hasTouch,
  });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => {
    pageErrors.push(err.message);
  });

  try {
    daemon1 = await spawnE2eDaemon({
      ALFRED_E2E_SQLITE_PATH: sqlitePath,
      ALFRED_E2E_MODE: "controlled",
      ALFRED_E2E_RETRY_ENABLED: "true",
      ALFRED_E2E_RETRY_BASE_MS: "50",
    });
    const daemonPort = daemon1.port;

    const appUrl = `http://127.0.0.1:${String(webPort)}/?daemonUrl=${encodeURIComponent(
      `http://127.0.0.1:${String(daemonPort)}`,
    )}`;
    await page.goto(appUrl, { waitUntil: "domcontentloaded" });

    // 1. Handshake (hello -> snapshot) shows Connected.
    await statusLocator(page, "Connected").waitFor({ state: "visible", timeout: 25_000 });
    await page
      .getByText("Send a message to start a Thread with Alfred.")
      .waitFor({ state: "visible", timeout: 10_000 });
    process.stdout.write(`  ✔ [${profile.name}] initial hello -> snapshot Connected\n`);

    // 2. Prompt 1: observe live incremental streaming (Streaming -> Connected).
    await submitPromptInUi(page, "Hello Alfred");
    await daemon1.waitForEvent((ev) => ev.event === "stream_started" && ev.callCount === 1);

    daemon1.sendCommand({ cmd: "push_chunk", text: "Live chunk 1 " });
    await statusLocator(page, "Streaming").waitFor({ state: "visible", timeout: 10_000 });
    await page
      .getByText("Alfred (streaming): Live chunk 1 ", { exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });

    daemon1.sendCommand({ cmd: "push_chunk", text: "and chunk 2." });
    await page
      .getByText("Alfred (streaming): Live chunk 1 and chunk 2.", { exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });

    daemon1.sendCommand({ cmd: "finish", text: "Live chunk 1 and chunk 2." });
    await statusLocator(page, "Connected").waitFor({ state: "visible", timeout: 10_000 });
    await page
      .getByText("Alfred (complete): Live chunk 1 and chunk 2.", { exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(
      await page.getByText("Owner (complete): Hello Alfred", { exact: true }).count(),
      1,
    );
    process.stdout.write(
      `  ✔ [${profile.name}] live incremental streaming Streaming -> Connected\n`,
    );

    // 3. Prompt 2: stream partial chunk, SIGKILL daemon mid-reply, restart daemon, verify auto-recovery.
    await submitPromptInUi(page, "Recover after crash");
    await daemon1.waitForEvent((ev) => ev.event === "stream_started" && ev.callCount === 2);

    daemon1.sendCommand({ cmd: "push_chunk", text: "Partial before SIGKILL " });
    await page
      .getByText("Alfred (streaming): Partial before SIGKILL ", { exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });

    await daemon1.killSigkill();
    daemon1 = undefined;

    await statusLocator(page, "Reconnecting").waitFor({ state: "visible", timeout: 10_000 });
    process.stdout.write(`  ✔ [${profile.name}] SIGKILL mid-reply -> Reconnecting observed\n`);

    daemon2 = await spawnE2eDaemon({
      ALFRED_DAEMON_PORT: String(daemonPort),
      ALFRED_E2E_SQLITE_PATH: sqlitePath,
      ALFRED_E2E_MODE: "auto",
      ALFRED_E2E_AUTO_REPLY: "Recovered reply after SIGKILL.",
      ALFRED_E2E_RETRY_ENABLED: "true",
      ALFRED_E2E_RETRY_BASE_MS: "50",
    });

    await statusLocator(page, "Connected").waitFor({ state: "visible", timeout: 25_000 });
    await page
      .getByText("Alfred (complete): Recovered reply after SIGKILL.", { exact: true })
      .waitFor({ state: "visible", timeout: 15_000 });

    assert.equal(
      await page.getByText("Owner (complete): Hello Alfred", { exact: true }).count(),
      1,
    );
    assert.equal(
      await page.getByText("Owner (complete): Recover after crash", { exact: true }).count(),
      1,
    );
    assert.equal(await ownerMessageCount(page), 2);
    process.stdout.write(
      `  ✔ [${profile.name}] auto-recovered via hello -> snapshot -> delta with 0 duplicate Owner turns\n`,
    );

    // 4. Verify requestId idempotency across restarted daemon and UI reload.
    const replay = await replayRequestOverWs(daemonPort, "Recover after crash");
    assert.equal(replay.deduplicated, true);

    await page.reload({ waitUntil: "domcontentloaded" });
    await statusLocator(page, "Connected").waitFor({ state: "visible", timeout: 25_000 });
    await page
      .getByText("Alfred (complete): Recovered reply after SIGKILL.", { exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await ownerMessageCount(page), 2);
    assert.equal(pageErrors.length, 0, `Unexpected page errors: ${pageErrors.join("; ")}`);
    process.stdout.write(`  ✔ [${profile.name}] requestId idempotency verified\n`);
  } finally {
    await context.close();
    if (daemon1 !== undefined) {
      await daemon1.stopGracefully();
    }
    if (daemon2 !== undefined) {
      await daemon2.stopGracefully();
    }
    cleanupTempDir(tempDir);
  }
}

/** Playwright Web E2E: compiled Flutter Web app against a real spawned daemon, desktop and iPhone viewports. */
export async function runWebE2e(): Promise<void> {
  if (process.env.ALFRED_E2E_REBUILD === "1" || isWebBuildStale()) {
    process.stdout.write("Building Flutter Web bundle...\n");
    runFlutterBuild("web");
  }

  let webServer: StaticWebServer | undefined;
  let browser: Browser | undefined;

  try {
    webServer = await startStaticWebServer(WEB_BUILD_DIR);
    browser = await launchPlaywrightBrowser();

    for (const profile of VIEWPORTS) {
      await runViewportScenario(browser, webServer.port, profile);
    }
    process.stdout.write("\n✔ Playwright Web E2E passed for all viewports.\n");
  } finally {
    if (browser !== undefined) {
      await browser.close();
    }
    if (webServer !== undefined) {
      await webServer.close();
    }
  }
}
