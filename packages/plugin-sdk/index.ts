// Public entry point of @alfred/plugin-sdk: the Connector contract.
// Phase 2 (specs/…-plugin-sdk.md) adds ConnectorPlugin, ConnectorTool, ConnectorTrigger, SecretStore.
export { RISK_LEVELS, isRiskLevel, requiresApproval, type RiskLevel } from "./lib/risk.ts";
