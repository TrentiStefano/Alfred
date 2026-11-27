import { describe, expect, it } from "vitest";
import fixture from "../health.fixture.json" with { type: "json" };
import { createHealthResponse, parseHealthResponse } from "../index.ts";

describe("HealthResponse contract", () => {
  it("matches the shared golden fixture", () => {
    expect(parseHealthResponse(fixture)).toEqual(createHealthResponse());
  });

  it("rejects malformed payloads", () => {
    expect(() => parseHealthResponse({ ok: "yes" })).toThrow();
    expect(() => parseHealthResponse(null)).toThrow();
  });
});
