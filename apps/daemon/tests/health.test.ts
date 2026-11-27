import { afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@alfred/protocol";
import { startDaemonServer, type DaemonServer } from "../index.ts";

describe("daemon /health endpoint", () => {
  let server: DaemonServer | undefined;

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
  });

  it("reports ok status, protocol version, and CORS headers", async () => {
    server = await startDaemonServer({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`http://127.0.0.1:${String(server.port)}/health`);

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const body: unknown = await response.json();
    expect(body).toEqual({
      ok: true,
      service: "alfred-daemon",
      protocolVersion: PROTOCOL_VERSION,
    });
  });

  it("returns 404 for unknown routes", async () => {
    server = await startDaemonServer({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`http://127.0.0.1:${String(server.port)}/unknown`);

    expect(response.status).toBe(404);
  });
});
