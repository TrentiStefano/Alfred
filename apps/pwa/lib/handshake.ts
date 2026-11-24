import { isSupportedProtocolVersion } from "@alfred/protocol";

/** Decide from the daemon's `hello` whether this PWA build may continue the session. */
export function canTalkToDaemon(hello: { protocolVersion: number }): boolean {
  return isSupportedProtocolVersion(hello.protocolVersion);
}
