import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  PROTOCOL_VERSION,
  createAckMessage,
  createErrorMessage,
  createSnapshotMessage,
  isSupportedProtocolVersion,
  parseClientMessage,
  type ClientMessage,
  type DaemonMessage,
  type ThreadSnapshot,
} from "@alfred/protocol";
import { AgentRuntimeError, type AgentRuntime } from "./agent-runtime.ts";

interface ConnectionState {
  socket: WebSocket;
  handshaked: boolean;
  nextSeq: number;
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

  function broadcastSnapshot(snapshot: ThreadSnapshot): void {
    for (const conn of connections) {
      if (!conn.handshaked || conn.socket.readyState !== WebSocket.OPEN) {
        continue;
      }
      const seq = conn.nextSeq;
      conn.nextSeq += 1;
      sendMessage(conn.socket, createSnapshotMessage({ seq, thread: snapshot }));
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
      conn.nextSeq = 1;
      const snapshot = await runtime.getSnapshot();
      sendMessage(conn.socket, createSnapshotMessage({ seq: 0, thread: snapshot }));
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
      if (!result.deduplicated) {
        broadcastSnapshot(result.snapshot);
      }
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
    }
  }

  wss.on("connection", (socket: WebSocket) => {
    const conn: ConnectionState = {
      socket,
      handshaked: false,
      nextSeq: 0,
      queue: Promise.resolve(),
    };
    connections.add(conn);

    socket.on("message", (data: RawData) => {
      const raw = rawDataToUtf8(data);
      conn.queue = conn.queue.then(() => handleClientMessage(conn, raw));
    });

    socket.on("close", () => {
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
