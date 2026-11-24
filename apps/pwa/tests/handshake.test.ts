import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@alfred/protocol";
import { canTalkToDaemon } from "../index.ts";

describe("canTalkToDaemon", () => {
  it("continues only with a daemon speaking the same protocol", () => {
    expect(canTalkToDaemon({ protocolVersion: PROTOCOL_VERSION })).toBe(true);
    expect(canTalkToDaemon({ protocolVersion: PROTOCOL_VERSION + 1 })).toBe(false);
  });
});
