import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@alfred/protocol";
import { describeDaemon } from "../index.ts";

describe("describeDaemon", () => {
  it("reports the protocol version it speaks", () => {
    expect(describeDaemon()).toContain(`protocol=${String(PROTOCOL_VERSION)}`);
  });
});
