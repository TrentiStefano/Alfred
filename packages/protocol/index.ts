// Public entry point of @alfred/protocol: pure schemas and types, zero I/O.
export { PROTOCOL_VERSION, isSupportedProtocolVersion } from "./lib/version.ts";
export {
  DAEMON_SERVICE_NAME,
  createHealthResponse,
  parseHealthResponse,
  type HealthResponse,
} from "./lib/health.ts";
