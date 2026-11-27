import { PROTOCOL_VERSION } from "./version.ts";

export const DAEMON_SERVICE_NAME = "alfred-daemon";

export interface HealthResponse {
  ok: boolean;
  service: string;
  protocolVersion: number;
}

/** Build the canonical daemon `/health` payload. */
export function createHealthResponse(ok = true): HealthResponse {
  return {
    ok,
    service: DAEMON_SERVICE_NAME,
    protocolVersion: PROTOCOL_VERSION,
  };
}

/** Validate an untrusted `/health` payload against the wire contract. */
export function parseHealthResponse(input: unknown): HealthResponse {
  if (typeof input !== "object" || input === null) {
    throw new Error("HealthResponse must be an object");
  }
  const record = input as Record<string, unknown>;
  if (
    typeof record.ok !== "boolean" ||
    typeof record.service !== "string" ||
    typeof record.protocolVersion !== "number" ||
    !Number.isInteger(record.protocolVersion)
  ) {
    throw new Error("HealthResponse is missing required fields");
  }
  return {
    ok: record.ok,
    service: record.service,
    protocolVersion: record.protocolVersion,
  };
}
