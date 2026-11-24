import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, isSupportedProtocolVersion } from "../index.ts";

describe("protocol version", () => {
  it("accepts its own version", () => {
    expect(isSupportedProtocolVersion(PROTOCOL_VERSION)).toBe(true);
  });

  it("rejects any other version", () => {
    expect(isSupportedProtocolVersion(PROTOCOL_VERSION + 1)).toBe(false);
  });
});
