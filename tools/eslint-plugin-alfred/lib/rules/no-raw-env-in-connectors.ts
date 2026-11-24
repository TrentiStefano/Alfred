import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import { createRule } from "../create-rule.ts";

const PROCESS_MODULES = new Set(["process", "node:process"]);

export const noRawEnvInConnectors = createRule({
  name: "no-raw-env-in-connectors",
  meta: {
    type: "problem",
    docs: {
      description:
        "Connectors read secrets and config only through the SecretStore given to init().",
    },
    schema: [],
    defaultOptions: [],
    messages: {
      rawEnv:
        "Connectors must not read environment variables directly. Declare the value in the Connector's `configSchema` (or as a secret) and read it from the `SecretStore` passed to `init()`, so the daemon can scope it to this Agent's Environment and redact it from logs and LLM context.",
    },
  },
  create(context) {
    return {
      MemberExpression(node) {
        if (
          node.object.type === AST_NODE_TYPES.Identifier &&
          node.object.name === "process" &&
          !node.computed &&
          node.property.type === AST_NODE_TYPES.Identifier &&
          node.property.name === "env"
        ) {
          context.report({ node, messageId: "rawEnv" });
        }
      },
      ImportDeclaration(node) {
        if (typeof node.source.value !== "string" || !PROCESS_MODULES.has(node.source.value)) {
          return;
        }
        for (const spec of node.specifiers) {
          const imported =
            spec.type === AST_NODE_TYPES.ImportSpecifier
              ? spec.imported.type === AST_NODE_TYPES.Identifier
                ? spec.imported.name
                : spec.imported.value
              : undefined;
          // Default/namespace imports expose `.env` too; named `env` exposes it directly.
          if (imported === undefined || imported === "env") {
            context.report({ node: spec, messageId: "rawEnv" });
          }
        }
      },
    };
  },
});
