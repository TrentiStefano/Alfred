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
import { createStubAgentRuntime, startDaemonServer, type DaemonServer } from "../index.ts";

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

  it("handles submit via stub AgentRuntime, sends ack and updated snapshot, and deduplicates requestId", async () => {
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

    const snapshot1 = await client.nextMessage();
    expect(snapshot1.type).toBe("snapshot");
    if (snapshot1.type === "snapshot") {
      expect(snapshot1.seq).toBe(1);
      expect(snapshot1.thread.status).toBe("idle");
      expect(snapshot1.thread.messages).toHaveLength(2);
      expect(snapshot1.thread.messages[0]?.role).toBe("owner");
      expect(snapshot1.thread.messages[0]?.text).toBe("Hello Alfred");
      expect(snapshot1.thread.messages[0]?.status).toBe("complete");
      expect(snapshot1.thread.messages[0]?.requestId).toBe("req-100");
      expect(snapshot1.thread.messages[1]?.role).toBe("agent");
      expect(snapshot1.thread.messages[1]?.status).toBe("complete");
    }

    // Re-submit the same requestId: deduplicates without adding messages.
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

    // A second client connecting later receives the persisted 2-message Thread in initial snapshot.
    const secondClient = await connectWs(server.port);
    secondClient.sendJson(createHelloMessage());
    const reconnectSnapshot = await secondClient.nextMessage();
    expect(reconnectSnapshot.type).toBe("snapshot");
    if (reconnectSnapshot.type === "snapshot") {
      expect(reconnectSnapshot.seq).toBe(0);
      expect(reconnectSnapshot.thread.messages).toHaveLength(2);
    }

    await secondClient.close();
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
