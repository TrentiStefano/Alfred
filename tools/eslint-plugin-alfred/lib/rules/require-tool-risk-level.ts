import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../create-rule.ts";

const RISK_LEVELS = new Set(["read", "write", "destructive"]);
const TOOL_TYPE = "ConnectorTool";
const TOOL_FACTORY = "defineTool";

function isToolTypeAnnotation(node: TSESTree.TypeNode | undefined): boolean {
  return (
    node?.type === AST_NODE_TYPES.TSTypeReference &&
    node.typeName.type === AST_NODE_TYPES.Identifier &&
    node.typeName.name === TOOL_TYPE
  );
}

function isToolFactoryCall(node: TSESTree.CallExpression): boolean {
  const callee = node.callee;
  if (callee.type === AST_NODE_TYPES.Identifier) return callee.name === TOOL_FACTORY;
  return (
    callee.type === AST_NODE_TYPES.MemberExpression &&
    !callee.computed &&
    callee.property.type === AST_NODE_TYPES.Identifier &&
    callee.property.name === TOOL_FACTORY
  );
}

function findRiskProperty(
  node: TSESTree.ObjectExpression,
): TSESTree.ObjectLiteralElement | undefined {
  return node.properties.find(
    (p) =>
      p.type === AST_NODE_TYPES.Property &&
      !p.computed &&
      ((p.key.type === AST_NODE_TYPES.Identifier && p.key.name === "risk") ||
        (p.key.type === AST_NODE_TYPES.Literal && p.key.value === "risk")),
  );
}

export const requireToolRiskLevel = createRule({
  name: "require-tool-risk-level",
  meta: {
    type: "problem",
    docs: {
      description: "Every ConnectorTool must declare an explicit literal Risk level.",
    },
    schema: [],
    defaultOptions: [],
    messages: {
      missingRisk:
        "This ConnectorTool has no Risk level. Add `risk: 'read'` if it only observes data, `risk: 'write'` if it changes data, or `risk: 'destructive'` if the change is hard or impossible to undo. Anything not 'read' is parked as an Approval (see GLOSSARY.md).",
      nonLiteralRisk:
        "`risk` must be the string literal 'read', 'write' or 'destructive' written inline, so reviewers and this rule can see it. Do not compute it or pass it through a variable.",
    },
  },
  create(context) {
    function check(node: TSESTree.ObjectExpression): void {
      const risk = findRiskProperty(node);
      if (risk?.type !== AST_NODE_TYPES.Property) {
        context.report({ node, messageId: "missingRisk" });
        return;
      }
      const value = risk.value;
      if (
        value.type !== AST_NODE_TYPES.Literal ||
        typeof value.value !== "string" ||
        !RISK_LEVELS.has(value.value)
      ) {
        context.report({ node: risk, messageId: "nonLiteralRisk" });
      }
    }

    return {
      CallExpression(node) {
        const arg = node.arguments[0];
        if (isToolFactoryCall(node) && arg?.type === AST_NODE_TYPES.ObjectExpression) check(arg);
      },
      VariableDeclarator(node) {
        if (
          node.init?.type === AST_NODE_TYPES.ObjectExpression &&
          isToolTypeAnnotation(node.id.typeAnnotation?.typeAnnotation)
        ) {
          check(node.init);
        }
      },
      TSSatisfiesExpression(node) {
        if (
          node.expression.type === AST_NODE_TYPES.ObjectExpression &&
          isToolTypeAnnotation(node.typeAnnotation)
        ) {
          check(node.expression);
        }
      },
    };
  },
});
