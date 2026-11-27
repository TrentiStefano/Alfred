import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  DEFAULT_MAIN_AGENT_NAME,
  DEFAULT_MAIN_THREAD_ID,
  PROTOCOL_VERSION,
  createHelloMessage,
  createSubmitMessage,
  parseDaemonMessage,
  type DaemonMessage,
} from "@alfred/protocol";
import {
  createStubAgentRuntime,
  startDaemonServer,
  type AgentRuntime,
  type DaemonServer,
  type ThreadDeltaEvent,
} from "../index.ts";

interface WsTestClient {
  nextMessage(): Promise<DaemonMessage>;
  waitForClose(): Promise<{ code: number; reason: string }>;
  sendJson(payload: unknown): void;
  sendRaw(raw: string): void;
  close(): Promise<void>;
}

async function connectWs(port: number, path = "/ws"): Promise<WsTestClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${String(port)}${path}`);
  const inbox: DaemonMessage[] = [];
  const waiters: ((message: DaemonMessage) => void)[] = [];
  let closedInfo: { code: number; reason: string } | undefined;
  const closeWaiters: ((info: { code: number; reason: string }) => void)[] = [];

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

  ws.on("close", (code, reason) => {
    const info = { code, reason: reason.toString("utf8") };
    closedInfo = info;
    while (closeWaiters.length > 0) {
      const waiter = closeWaiters.shift();
      waiter?.(info);
    }
  });

  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => {
      resolve();
    });
    ws.once("error", (err) => {
      reject(err);
    });
  });

  return {
    nextMessage: () => {
      const queued = inbox.shift();
      if (queued !== undefined) {
        return Promise.resolve(queued);
      }
      return new Promise<DaemonMessage>((resolve) => {
        waiters.push(resolve);
      });
    },
    waitForClose: () => {
      if (closedInfo !== undefined) {
        return Promise.resolve(closedInfo);
      }
      return new Promise<{ code: number; reason: string }>((resolve) => {
        closeWaiters.push(resolve);
      });
    },
    sendJson: (payload: unknown) => {
      ws.send(JSON.stringify(payload));
    },
    sendRaw: (raw: string) => {
      ws.send(raw);
    },
    close: () => {
      if (ws.readyState === WebSocket.CLOSED) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        ws.once("close", () => {
          resolve();
        });
        ws.close();
      });
    },
  };
}

describe("daemon /ws handshake & snapshot", () => {
  let server: DaemonServer | undefined;

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
  });

  it("rejects messages sent before hello with handshake_required", async () => {
    server = await startDaemonServer({ host: "127.0.0.1", port: 0 });
    const client = await connectWs(server.port);

    client.sendJson(
      createSubmitMessage({
        threadId: DEFAULT_MAIN_THREAD_ID,
        requestId: "req-before-hello",
        text: "Hello before handshake",
      }),
    );

    const response = await client.nextMessage();
    expect(response).toEqual({
      type: "error",
      code: "handshake_required",
      message: expect.any(String) as string,
    });
    await client.close();
  });

  it("rejects unsupported protocolVersion with error and closes socket", async () => {
    server = await startDaemonServer({ host: "127.0.0.1", port: 0 });
    const client = await connectWs(server.port);
    const futureVersion = PROTOCOL_VERSION + 1;

    client.sendJson(createHelloMessage({ protocolVersion: futureVersion }));

    const response = await client.nextMessage();
    expect(response).toEqual({
      type: "error",
      code: "unsupported_protocol_version",
      message: expect.stringContaining(String(PROTOCOL_VERSION)) as string,
      protocolVersion: futureVersion,
      expectedProtocolVersion: PROTOCOL_VERSION,
    });

    const closed = await client.waitForClose();
    expect(closed.code).not.toBe(1000);
  });

  it("returns invalid_message for malformed JSON", async () => {
    server = await startDaemonServer({ host: "127.0.0.1", port: 0 });
    const client = await connectWs(server.port);

    client.sendRaw("{not-json");

    const response = await client.nextMessage();
    expect(response).toEqual({
      type: "error",
      code: "invalid_message",
      message: expect.any(String) as string,
    });
    await client.close();
  });

  it("sends initial empty snapshot (seq: 0) on valid hello and closes cleanly", async () => {
    server = await startDaemonServer({ host: "127.0.0.1", port: 0 });
    const client = await connectWs(server.port);

    client.sendJson(
      createHelloMessage({
        client: { name: "alfred-test", version: "0.0.1", platform: "node" },
      }),
    );

    const response = await client.nextMessage();
    expect(response).toEqual({
      type: "snapshot",
      protocolVersion: PROTOCOL_VERSION,
      seq: 0,
      thread: {
        id: DEFAULT_MAIN_THREAD_ID,
        agentName: DEFAULT_MAIN_AGENT_NAME,
        status: "idle",
        messages: [],
      },
    });

    // Server close must resolve promptly even with an active WS client.
    const closePromise = client.waitForClose();
    await server.close();
    server = undefined;
    const closed = await closePromise;
    expect(closed.code).toBe(1001);
  });

  it("handles submit via stub AgentRuntime, sends ack and sequenced deltas, and deduplicates requestId", async () => {
    server = await startDaemonServer({ host: "127.0.0.1", port: 0 });
    const client = await connectWs(server.port);

    client.sendJson(createHelloMessage());
    const initialSnapshot = await client.nextMessage();
    expect(initialSnapshot.type).toBe("snapshot");

    client.sendJson(
      createSubmitMessage({
        threadId: DEFAULT_MAIN_THREAD_ID,
        requestId: "req-100",
        text: "Hello Alfred",
      }),
    );

    const ack1 = await client.nextMessage();
    expect(ack1).toEqual({
      type: "ack",
      threadId: DEFAULT_MAIN_THREAD_ID,
      requestId: "req-100",
      submissionId: "sub-1",
      deduplicated: false,
    });

    const d1 = await client.nextMessage();
    const d2 = await client.nextMessage();
    const d3 = await client.nextMessage();
    const d4 = await client.nextMessage();
    const d5 = await client.nextMessage();
    expect(d1).toEqual({
      type: "delta",
      protocolVersion: PROTOCOL_VERSION,
      threadId: DEFAULT_MAIN_THREAD_ID,
      seq: 1,
      event: {
        kind: "turn_start",
        messageId: "msg-1",
        role: "owner",
        text: "Hello Alfred",
        requestId: "req-100",
        createdAt: expect.any(String) as string,
      },
    });
    expect(d2).toEqual({
      type: "delta",
      protocolVersion: PROTOCOL_VERSION,
      threadId: DEFAULT_MAIN_THREAD_ID,
      seq: 2,
      event: {
        kind: "turn_finish",
        messageId: "msg-1",
        status: "complete",
      },
    });
    expect(d3).toEqual({
      type: "delta",
      protocolVersion: PROTOCOL_VERSION,
      threadId: DEFAULT_MAIN_THREAD_ID,
      seq: 3,
      event: {
        kind: "turn_start",
        messageId: "msg-2",
        role: "agent",
        createdAt: expect.any(String) as string,
      },
    });
    expect(d4).toEqual({
      type: "delta",
      protocolVersion: PROTOCOL_VERSION,
      threadId: DEFAULT_MAIN_THREAD_ID,
      seq: 4,
      event: {
        kind: "text_delta",
        messageId: "msg-2",
        delta: "Stub Alfred received: Hello Alfred",
      },
    });
    expect(d5).toEqual({
      type: "delta",
      protocolVersion: PROTOCOL_VERSION,
      threadId: DEFAULT_MAIN_THREAD_ID,
      seq: 5,
      event: {
        kind: "turn_finish",
        messageId: "msg-2",
        status: "complete",
      },
    });

    // Re-submit the same requestId: deduplicates without adding messages or emitting deltas.
    client.sendJson(
      createSubmitMessage({
        threadId: DEFAULT_MAIN_THREAD_ID,
        requestId: "req-100",
        text: "Hello Alfred",
      }),
    );

    const ack2 = await client.nextMessage();
    expect(ack2).toEqual({
      type: "ack",
      threadId: DEFAULT_MAIN_THREAD_ID,
      requestId: "req-100",
      submissionId: "sub-1",
      deduplicated: true,
    });

    // A second client connecting later receives the persisted 2-message Thread in initial snapshot with seq 5.
    const secondClient = await connectWs(server.port);
    secondClient.sendJson(createHelloMessage());
    const reconnectSnapshot = await secondClient.nextMessage();
    expect(reconnectSnapshot.type).toBe("snapshot");
    if (reconnectSnapshot.type === "snapshot") {
      expect(reconnectSnapshot.seq).toBe(5);
      expect(reconnectSnapshot.thread.messages).toHaveLength(2);
      expect(reconnectSnapshot.thread.messages[0]?.requestId).toBe("req-100");
      expect(reconnectSnapshot.thread.messages[1]?.text).toBe("Stub Alfred received: Hello Alfred");
    }

    await secondClient.close();
    await client.close();
  });

  it("aligns snapshot.seq with buffered deltas during subscribeThread without duplicates or gaps", async () => {
    let resolveRelease!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      resolveRelease = resolve;
    });
    let resolveSubscribeStarted!: () => void;
    const subscribeStartedPromise = new Promise<void>((resolve) => {
      resolveSubscribeStarted = resolve;
    });
    const listeners = new Set<(delta: ThreadDeltaEvent) => void>();

    const runtime: AgentRuntime = {
      getSnapshot() {
        return Promise.resolve({
          id: DEFAULT_MAIN_THREAD_ID,
          agentName: DEFAULT_MAIN_AGENT_NAME,
          status: "streaming",
          messages: [],
        });
      },
      async subscribeThread(threadId, listener) {
        listeners.add(listener);
        resolveSubscribeStarted();
        await releasePromise;
        return {
          seq: 1,
          snapshot: {
            id: threadId,
            agentName: DEFAULT_MAIN_AGENT_NAME,
            status: "streaming",
            messages: [
              {
                id: "m1",
                role: "agent",
                text: "First ",
                status: "streaming",
                createdAt: "2026-11-27T12:00:00.000Z",
              },
            ],
          },
          unsubscribe: () => {
            listeners.delete(listener);
          },
        };
      },
      submit(input) {
        return Promise.resolve({
          threadId: input.threadId,
          requestId: input.requestId,
          submissionId: "sub-mock",
          deduplicated: false,
        });
      },
    };

    server = await startDaemonServer({ host: "127.0.0.1", port: 0, agentRuntime: runtime });
    const client = await connectWs(server.port);
    client.sendJson(createHelloMessage());

    await subscribeStartedPromise;
    // Emit seq 1 (already inside snapshot) and seq 2 (new) while subscribeThread is still pending.
    for (const listener of listeners) {
      listener({
        threadId: DEFAULT_MAIN_THREAD_ID,
        seq: 1,
        event: { kind: "text_delta", messageId: "m1", delta: "First " },
      });
      listener({
        threadId: DEFAULT_MAIN_THREAD_ID,
        seq: 2,
        event: { kind: "text_delta", messageId: "m1", delta: "Second" },
      });
    }
    resolveRelease();

    const snap = await client.nextMessage();
    expect(snap.type).toBe("snapshot");
    if (snap.type === "snapshot") {
      expect(snap.seq).toBe(1);
      expect(snap.thread.messages[0]?.text).toBe("First ");
    }

    const next = await client.nextMessage();
    expect(next).toEqual({
      type: "delta",
      protocolVersion: PROTOCOL_VERSION,
      threadId: DEFAULT_MAIN_THREAD_ID,
      seq: 2,
      event: { kind: "text_delta", messageId: "m1", delta: "Second" },
    });

    await client.close();
  });

  it("returns unknown_thread and invalid_message errors after handshake", async () => {
    const customRuntime = createStubAgentRuntime({
      replyText: (prompt) => `Custom reply: ${prompt}`,
    });
    server = await startDaemonServer({
      host: "127.0.0.1",
      port: 0,
      agentRuntime: customRuntime,
    });
    const client = await connectWs(server.port);

    client.sendJson(createHelloMessage());
    await client.nextMessage();

    client.sendJson(
      createSubmitMessage({
        threadId: "non-existent",
        requestId: "req-missing",
        text: "Hi?",
      }),
    );
    const unknownError = await client.nextMessage();
    expect(unknownError).toEqual({
      type: "error",
      code: "unknown_thread",
      message: expect.any(String) as string,
      threadId: "non-existent",
      requestId: "req-missing",
    });

    client.sendJson({ type: "submit", threadId: "main", requestId: "r2", text: "   " });
    const invalidError = await client.nextMessage();
    expect(invalidError).toEqual({
      type: "error",
      code: "invalid_message",
      message: expect.any(String) as string,
    });

    await client.close();
  });
});
