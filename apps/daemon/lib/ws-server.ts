import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  DEFAULT_MAIN_THREAD_ID,
  PROTOCOL_VERSION,
  createAckMessage,
  createDeltaMessage,
  createErrorMessage,
  createSnapshotMessage,
  isSupportedProtocolVersion,
  parseClientMessage,
  type ClientMessage,
  type DaemonMessage,
} from "@alfred/protocol";
import { AgentRuntimeError, type AgentRuntime, type ThreadDeltaEvent } from "./agent-runtime.ts";

interface ConnectionState {
  socket: WebSocket;
  handshaked: boolean;
  submittingCount: number;
  pendingSubmitDeltas: ThreadDeltaEvent[];
  unsubscribe: (() => void) | undefined;
  queue: Promise<void>;
}

function rawDataToUtf8(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

function sendMessage(socket: WebSocket, message: DaemonMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function parseJsonClientMessage(raw: string): ClientMessage {
  const parsedJson: unknown = JSON.parse(raw);
  return parseClientMessage(parsedJson);
}

/** Attach the `/ws` protocol endpoint onto an existing Node HTTP server. */
export function attachWebSocketServer(
  server: Server,
  runtime: AgentRuntime,
): { close(): Promise<void> } {
  const wss = new WebSocketServer({ noServer: true });
  const connections = new Set<ConnectionState>();

  function sendDelta(conn: ConnectionState, delta: ThreadDeltaEvent): void {
    sendMessage(
      conn.socket,
      createDeltaMessage({
        threadId: delta.threadId,
        seq: delta.seq,
        event: delta.event,
      }),
    );
  }

  function flushPendingSubmitDeltas(conn: ConnectionState): void {
    if (conn.submittingCount > 0 || conn.pendingSubmitDeltas.length === 0) {
      return;
    }
    const pending = conn.pendingSubmitDeltas.splice(0);
    for (const delta of pending) {
      sendDelta(conn, delta);
    }
  }

  async function handleClientMessage(conn: ConnectionState, raw: string): Promise<void> {
    let message: ClientMessage;
    try {
      message = parseJsonClientMessage(raw);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Invalid WebSocket payload.";
      sendMessage(
        conn.socket,
        createErrorMessage({
          code: "invalid_message",
          message: detail,
        }),
      );
      return;
    }

    if (!conn.handshaked) {
      if (message.type !== "hello") {
        sendMessage(
          conn.socket,
          createErrorMessage({
            code: "handshake_required",
            message: "Send a hello message before submitting requests.",
          }),
        );
        return;
      }

      if (!isSupportedProtocolVersion(message.protocolVersion)) {
        sendMessage(
          conn.socket,
          createErrorMessage({
            code: "unsupported_protocol_version",
            message: `Unsupported protocol version ${String(message.protocolVersion)}; expected ${String(PROTOCOL_VERSION)}.`,
            protocolVersion: message.protocolVersion,
            expectedProtocolVersion: PROTOCOL_VERSION,
          }),
        );
        conn.socket.close(1008, "unsupported_protocol_version");
        return;
      }

      conn.handshaked = true;
      const bufferedDuringSubscribe: ThreadDeltaEvent[] = [];
      let subscribed = false;
      let snapshotSeq = 0;
      const subscription = await runtime.subscribeThread(DEFAULT_MAIN_THREAD_ID, (delta) => {
        if (!subscribed) {
          bufferedDuringSubscribe.push(delta);
          return;
        }
        if (delta.seq <= snapshotSeq) {
          return;
        }
        if (conn.submittingCount > 0) {
          conn.pendingSubmitDeltas.push(delta);
          return;
        }
        sendDelta(conn, delta);
      });

      if (conn.socket.readyState !== WebSocket.OPEN) {
        subscription.unsubscribe();
        return;
      }

      conn.unsubscribe = () => {
        subscription.unsubscribe();
      };
      snapshotSeq = subscription.seq;
      subscribed = true;
      sendMessage(
        conn.socket,
        createSnapshotMessage({ seq: subscription.seq, thread: subscription.snapshot }),
      );
      for (const delta of bufferedDuringSubscribe) {
        if (delta.seq > snapshotSeq) {
          sendDelta(conn, delta);
        }
      }
      bufferedDuringSubscribe.length = 0;
      return;
    }

    if (message.type === "hello") {
      sendMessage(
        conn.socket,
        createErrorMessage({
          code: "invalid_state",
          message: "hello handshake already completed on this connection.",
        }),
      );
      return;
    }

    conn.submittingCount += 1;
    try {
      const result = await runtime.submit({
        threadId: message.threadId,
        requestId: message.requestId,
        text: message.text,
      });
      sendMessage(
        conn.socket,
        createAckMessage({
          threadId: result.threadId,
          requestId: result.requestId,
          submissionId: result.submissionId,
          deduplicated: result.deduplicated,
        }),
      );
    } catch (error) {
      if (error instanceof AgentRuntimeError) {
        sendMessage(
          conn.socket,
          createErrorMessage({
            code: error.code,
            message: error.message,
            threadId: error.threadId ?? message.threadId,
            requestId: error.requestId ?? message.requestId,
          }),
        );
        return;
      }
      sendMessage(
        conn.socket,
        createErrorMessage({
          code: "runtime_error",
          message: error instanceof Error ? error.message : "Agent runtime error.",
          threadId: message.threadId,
          requestId: message.requestId,
        }),
      );
    } finally {
      conn.submittingCount -= 1;
      flushPendingSubmitDeltas(conn);
    }
  }

  wss.on("connection", (socket: WebSocket) => {
    const conn: ConnectionState = {
      socket,
      handshaked: false,
      submittingCount: 0,
      pendingSubmitDeltas: [],
      unsubscribe: undefined,
      queue: Promise.resolve(),
    };
    connections.add(conn);

    socket.on("message", (data: RawData) => {
      const raw = rawDataToUtf8(data);
      conn.queue = conn.queue.then(() => handleClientMessage(conn, raw));
    });

    socket.on("close", () => {
      conn.unsubscribe?.();
      conn.unsubscribe = undefined;
      connections.delete(conn);
    });
  });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (path !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      wss.emit("connection", ws, req);
    });
  });

  return {
    close: async () => {
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
          client.close(1001, "server_shutdown");
        }
      }
      await new Promise<void>((resolve, reject) => {
        wss.close((err) => {
          if (err !== undefined) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    },
  };
}
