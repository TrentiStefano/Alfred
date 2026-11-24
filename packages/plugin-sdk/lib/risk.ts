/** Declared consequence of running a Tool (see GLOSSARY.md: Risk level). */
export const RISK_LEVELS = ["read", "write", "destructive"] as const;

export type RiskLevel = (typeof RISK_LEVELS)[number];

export function isRiskLevel(value: unknown): value is RiskLevel {
  return typeof value === "string" && (RISK_LEVELS as readonly string[]).includes(value);
}

/** Every Tool that is not `read` must be parked as an Approval before it runs. */
export function requiresApproval(risk: RiskLevel): boolean {
  return risk !== "read";
}
