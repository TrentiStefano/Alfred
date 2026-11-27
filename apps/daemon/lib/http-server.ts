import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { PROTOCOL_VERSION } from "@alfred/protocol";

export interface DaemonServerOptions {
  host?: string;
  port?: number;
}

export interface DaemonServer {
  port: number;
  close(): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
  });
  res.end(JSON.stringify(payload));
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const method = req.method ?? "GET";
  const path = (req.url ?? "/").split("?")[0] ?? "/";

  if (method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
    });
    res.end();
    return;
  }

  if (method === "GET" && path === "/health") {
    sendJson(res, 200, {
      ok: true,
      service: "alfred-daemon",
      protocolVersion: PROTOCOL_VERSION,
    });
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}

/** Start the daemon HTTP server (health and version endpoint). */
export async function startDaemonServer(options: DaemonServerOptions = {}): Promise<DaemonServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const server = createServer(handleRequest);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}
