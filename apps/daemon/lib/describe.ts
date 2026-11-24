import { PROTOCOL_VERSION } from "@alfred/protocol";

/** One-line identity the daemon reports in its `hello` handshake and health output. */
export function describeDaemon(): string {
  return `alfred-daemon protocol=${String(PROTOCOL_VERSION)}`;
}
