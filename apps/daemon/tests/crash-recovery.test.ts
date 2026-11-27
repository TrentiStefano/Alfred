import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  DEFAULT_MAIN_THREAD_ID,
  createHelloMessage,
  createSubmitMessage,
  parseDaemonMessage,
  type DaemonMessage,
  type SnapshotMessage,
} from "@alfred/protocol";

const E2E_DAEMON_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "e2e-daemon.ts");

interface DaemonEvent {
  event: string;
  port?: number;
  callCount?: number;
  prompt?: string;
}

interface SpawnedDaemon {
  process: ChildProcess;
  port: number;
  sendCommand(cmd: Record<string, unknown>): void;
  waitForEvent(predicate: (ev: DaemonEvent) => boolean): Promise<DaemonEvent>;
  killSigkill(): Promise<void>;
  stopGracefully(): Promise<void>;
}

async function spawnTestDaemon(envOverrides: Record<string, string>): Promise<SpawnedDaemon> {
  const child = spawn(process.execPath, [E2E_DAEMON_PATH], {
    env: {
      ...process.env,
      ALFRED_DAEMON_HOST: "127.0.0.1",
      ALFRED_DAEMON_PORT: "0",
      ...envOverrides,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const events: DaemonEvent[] = [];
  const waiters: ((ev: DaemonEvent) => void)[] = [];
  let stderrBuffer = "";

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      return;
    }
    const parsed = JSON.parse(trimmed) as DaemonEvent;
    const waiter = waiters.shift();
    if (waiter !== undefined) {
      waiter(parsed);
    } else {
      events.push(parsed);
    }
  });

  child.stderr.on("data", (chunk: Buffer) => {
    stderrBuffer += chunk.toString("utf8");
  });

  const nextEvent = (): Promise<DaemonEvent> => {
    const queued = events.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    return new Promise<DaemonEvent>((resolveEvent, rejectEvent) => {
      const onExit = (code: number | null) => {
        rejectEvent(
          new Error(`Daemon exited unexpectedly with code ${String(code)}: ${stderrBuffer}`),
        );
      };
      child.once("exit", onExit);
      waiters.push((ev) => {
        child.off("exit", onExit);
        resolveEvent(ev);
      });
    });
  };

  const waitForEvent = async (predicate: (ev: DaemonEvent) => boolean): Promise<DaemonEvent> => {
    for (;;) {
      const ev = await nextEvent();
      if (predicate(ev)) {
        return ev;
      }
    }
  };

  const listening = await waitForEvent((ev) => ev.event === "listening");
  if (listening.port === undefined) {
    throw new Error(`Listening event missing port: ${JSON.stringify(listening)}`);
  }

  const waitForExit = (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve();
    }
    return new Promise<void>((resolveExit) => {
      child.once("exit", () => {
        rl.close();
        resolveExit();
      });
    });
  };

  return {
    process: child,
    port: listening.port,
    sendCommand: (cmd) => {
      child.stdin.write(`${JSON.stringify(cmd)}\n`);
    },
    waitForEvent,
    killSigkill: async () => {
      const exiting = waitForExit();
      child.kill("SIGKILL");
      await exiting;
    },
    stopGracefully: async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      const exiting = waitForExit();
      child.kill("SIGTERM");
      await exiting;
    },
  };
}

interface WsClientHandle {
  nextMessage(): Promise<DaemonMessage>;
  sendJson(payload: unknown): void;
  close(): Promise<void>;
}

async function connectWs(port: number): Promise<WsClientHandle> {
  const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
  const inbox: DaemonMessage[] = [];
  const waiters: ((msg: DaemonMessage) => void)[] = [];

  ws.on("message", (data) => {
    const text =
      typeof data === "string"
        ? data
        : Buffer.isBuffer(data)
          ? data.toString("utf8")
          : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]).toString("utf8");
    const parsed = parseDaemonMessage(JSON.parse(text));
    const waiter = waiters.shift();
    if (waiter !== undefined) {
      waiter(parsed);
    } else {
      inbox.push(parsed);
    }
  });

  await new Promise<void>((resolveOpen, rejectOpen) => {
    ws.once("open", () => {
      resolveOpen();
    });
    ws.once("error", (err) => {
      rejectOpen(err);
    });
  });

  return {
    nextMessage: () => {
      const queued = inbox.shift();
      if (queued !== undefined) {
        return Promise.resolve(queued);
      }
      return new Promise<DaemonMessage>((resolveMsg) => {
        waiters.push(resolveMsg);
      });
    },
    sendJson: (payload) => {
      ws.send(JSON.stringify(payload));
    },
    close: () => {
      if (ws.readyState === WebSocket.CLOSED) {
        return Promise.resolve();
      }
      return new Promise<void>((resolveClose) => {
        ws.once("close", () => {
          resolveClose();
        });
        ws.close();
      });
    },
  };
}

async function handshake(client: WsClientHandle): Promise<SnapshotMessage> {
  client.sendJson(createHelloMessage());
  const msg = await client.nextMessage();
  if (msg.type !== "snapshot") {
    throw new Error(`Expected snapshot after hello, got ${msg.type}`);
  }
  return msg;
}

async function waitForTextDelta(client: WsClientHandle, expectedDelta: string): Promise<string> {
  for (;;) {
    const msg = await client.nextMessage();
    if (msg.type === "delta" && msg.event.kind === "text_delta") {
      expect(msg.event.delta).toBe(expectedDelta);
      return msg.event.messageId;
    }
  }
}

describe("Daemon SIGKILL + Pi Durable resume() crash recovery", () => {
  const tempDirs: string[] = [];
  const daemons: SpawnedDaemon[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "alfred-crash-recovery-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
      await daemon.stopGracefully();
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recovers an interrupted reply via resume() on restart, distinguishes attempt messageIds, and preserves requestId idempotency", async () => {
    const dir = makeTempDir();
    const sqlitePath = join(dir, "main.sqlite");

    const daemon1 = await spawnTestDaemon({
      ALFRED_E2E_SQLITE_PATH: sqlitePath,
      ALFRED_E2E_MODE: "controlled",
      ALFRED_E2E_RETRY_ENABLED: "true",
      ALFRED_E2E_RETRY_BASE_MS: "25",
    });
    daemons.push(daemon1);

    const client1 = await connectWs(daemon1.port);
    const snap1 = await handshake(client1);
    expect(snap1.thread.messages).toHaveLength(0);

    client1.sendJson(
      createSubmitMessage({
        threadId: DEFAULT_MAIN_THREAD_ID,
        requestId: "req-crash-1",
        text: "Survive SIGKILL",
      }),
    );

    const ack1 = await client1.nextMessage();
    expect(ack1).toMatchObject({
      type: "ack",
      requestId: "req-crash-1",
      deduplicated: false,
    });

    await daemon1.waitForEvent((ev) => ev.event === "stream_started");
    daemon1.sendCommand({ cmd: "push_chunk", text: "Partial before kill " });

    const attempt1MessageId = await waitForTextDelta(client1, "Partial before kill ");
    expect(attempt1MessageId).toMatch(/^live-gen-.+-a1$/);

    // Abruptly terminate daemon1 mid-stream with SIGKILL.
    await daemon1.killSigkill();
    await client1.close();

    // Restart daemon2 on the same SQLite database in controlled mode so we observe attempt 2 live.
    const daemon2 = await spawnTestDaemon({
      ALFRED_E2E_SQLITE_PATH: sqlitePath,
      ALFRED_E2E_MODE: "controlled",
      ALFRED_E2E_RETRY_ENABLED: "true",
      ALFRED_E2E_RETRY_BASE_MS: "25",
    });
    daemons.push(daemon2);

    const client2 = await connectWs(daemon2.port);
    const snap2 = await handshake(client2);
    expect(snap2.thread.messages.filter((m) => m.role === "owner")).toHaveLength(1);

    await daemon2.waitForEvent((ev) => ev.event === "stream_started");
    daemon2.sendCommand({ cmd: "push_chunk", text: "Recovered " });

    const attempt2MessageId = await waitForTextDelta(client2, "Recovered ");
    expect(attempt2MessageId).toMatch(/^live-gen-.+-a2$/);
    expect(attempt2MessageId).not.toBe(attempt1MessageId);

    daemon2.sendCommand({ cmd: "finish", text: "Recovered reply complete." });
    for (;;) {
      const msg = await client2.nextMessage();
      if (
        msg.type === "delta" &&
        msg.event.kind === "turn_finish" &&
        msg.event.messageId === attempt2MessageId
      ) {
        break;
      }
    }

    // Re-submitting the original requestId after crash recovery deduplicates cleanly.
    client2.sendJson(
      createSubmitMessage({
        threadId: DEFAULT_MAIN_THREAD_ID,
        requestId: "req-crash-1",
        text: "Survive SIGKILL",
      }),
    );
    const dedupAck = await client2.nextMessage();
    expect(dedupAck).toMatchObject({
      type: "ack",
      requestId: "req-crash-1",
      deduplicated: true,
    });

    // Fresh snapshot confirms persisted SQLite transcript has zero duplicated Owner turns.
    const client3 = await connectWs(daemon2.port);
    const finalSnap = await handshake(client3);
    expect(finalSnap.thread.status).toBe("idle");
    const ownerMsgs = finalSnap.thread.messages.filter((m) => m.role === "owner");
    expect(ownerMsgs).toHaveLength(1);
    expect(ownerMsgs[0]?.requestId).toBe("req-crash-1");
    expect(ownerMsgs[0]?.text).toBe("Survive SIGKILL");

    const lastAgent = finalSnap.thread.messages.at(-1);
    expect(lastAgent?.role).toBe("agent");
    expect(lastAgent?.status).toBe("complete");
    expect(lastAgent?.text).toBe("Recovered reply complete.");

    await client2.close();
    await client3.close();
  }, 20_000);

  it("settles an interrupted reply cleanly as interrupted when retry is disabled without duplicating turns", async () => {
    const dir = makeTempDir();
    const sqlitePath = join(dir, "main.sqlite");

    const daemon1 = await spawnTestDaemon({
      ALFRED_E2E_SQLITE_PATH: sqlitePath,
      ALFRED_E2E_MODE: "controlled",
      ALFRED_E2E_RETRY_ENABLED: "false",
    });
    daemons.push(daemon1);

    const client1 = await connectWs(daemon1.port);
    await handshake(client1);

    client1.sendJson(
      createSubmitMessage({
        threadId: DEFAULT_MAIN_THREAD_ID,
        requestId: "req-crash-noretry",
        text: "Do not retry",
      }),
    );
    await client1.nextMessage(); // ack

    await daemon1.waitForEvent((ev) => ev.event === "stream_started");
    daemon1.sendCommand({ cmd: "push_chunk", text: "Interrupted partial" });
    for (;;) {
      const msg = await client1.nextMessage();
      if (msg.type === "delta" && msg.event.kind === "text_delta") {
        break;
      }
    }

    await daemon1.killSigkill();
    await client1.close();

    const daemon2 = await spawnTestDaemon({
      ALFRED_E2E_SQLITE_PATH: sqlitePath,
      ALFRED_E2E_MODE: "controlled",
      ALFRED_E2E_RETRY_ENABLED: "false",
    });
    daemons.push(daemon2);

    const client2 = await connectWs(daemon2.port);
    const snap = await handshake(client2);

    let finalThread = snap.thread;
    if (finalThread.status === "streaming") {
      for (;;) {
        const msg = await client2.nextMessage();
        if (msg.type === "delta" && msg.event.kind === "turn_error") {
          expect(msg.event.status).toBe("interrupted");
          break;
        }
      }
      const client3 = await connectWs(daemon2.port);
      finalThread = (await handshake(client3)).thread;
      await client3.close();
    }

    expect(finalThread.status).toBe("error");
    const ownerMsgs = finalThread.messages.filter((m) => m.role === "owner");
    expect(ownerMsgs).toHaveLength(1);
    expect(ownerMsgs[0]?.requestId).toBe("req-crash-noretry");
    const lastAgent = finalThread.messages.at(-1);
    expect(lastAgent?.role).toBe("agent");
    expect(lastAgent?.status).toBe("interrupted");

    await client2.close();
  }, 20_000);
});
