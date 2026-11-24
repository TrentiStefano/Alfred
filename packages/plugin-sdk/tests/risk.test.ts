import { describe, expect, it } from "vitest";
import { RISK_LEVELS, isRiskLevel, requiresApproval } from "../index.ts";

describe("Risk level", () => {
  it("recognises exactly the three declared levels", () => {
    expect(RISK_LEVELS.every(isRiskLevel)).toBe(true);
    expect(isRiskLevel("admin")).toBe(false);
    expect(isRiskLevel(undefined)).toBe(false);
  });

  it("requires an Approval for anything that is not read-only", () => {
    expect(requiresApproval("read")).toBe(false);
    expect(requiresApproval("write")).toBe(true);
    expect(requiresApproval("destructive")).toBe(true);
  });
});
