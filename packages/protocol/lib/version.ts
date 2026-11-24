/** Wire protocol version shared by the daemon and the PWA. */
export const PROTOCOL_VERSION = 1;

/** True when a peer announcing `version` can talk to this build. */
export function isSupportedProtocolVersion(version: number): boolean {
  return version === PROTOCOL_VERSION;
}
