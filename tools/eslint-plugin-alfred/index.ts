// Alfred's own lint rules. Each one encodes a harness finding (see `/retro` in AGENTS.md):
// when an agent keeps making the same mistake, add a rule here with a prescriptive message.
import type { TSESLint } from "@typescript-eslint/utils";
import type { ESLint } from "eslint";
import { noRawEnvInConnectors } from "./lib/rules/no-raw-env-in-connectors.ts";
import { noTimerHacks } from "./lib/rules/no-timer-hacks.ts";
import { requireToolRiskLevel } from "./lib/rules/require-tool-risk-level.ts";

export const rules = {
  "require-tool-risk-level": requireToolRiskLevel,
  "no-raw-env-in-connectors": noRawEnvInConnectors,
  "no-timer-hacks": noTimerHacks,
};

const tsPlugin: TSESLint.FlatConfig.Plugin = {
  meta: { name: "eslint-plugin-alfred" },
  rules,
};

// Interop seam: typescript-eslint's rule types and ESLint core's Plugin type disagree under
// `exactOptionalPropertyTypes`. The runtime shape is identical; this is the only cast allowed.
const plugin = tsPlugin as unknown as ESLint.Plugin;

export default plugin;
