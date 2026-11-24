import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import { createRule } from "../create-rule.ts";

const TIMERS = new Set(["setTimeout", "setInterval", "setImmediate"]);
const GLOBAL_OBJECTS = new Set(["globalThis", "global", "window", "self"]);
const TIMER_MODULES = new Set(["timers", "node:timers", "timers/promises", "node:timers/promises"]);

export const noTimerHacks = createRule({
  name: "no-timer-hacks",
  meta: {
    type: "problem",
    docs: {
      description: "Tests must not wait on real timers; they mask async race conditions.",
    },
    schema: [],
    defaultOptions: [],
    messages: {
      realTimer:
        "Do not use real timers in tests: a sleep hides race conditions and makes the suite slow and flaky. Await the promise or event you are waiting for, or use `vi.useFakeTimers()` with `vi.advanceTimersByTimeAsync()` to test time-dependent code.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        const isBare = callee.type === AST_NODE_TYPES.Identifier && TIMERS.has(callee.name);
        const isGlobal =
          callee.type === AST_NODE_TYPES.MemberExpression &&
          !callee.computed &&
          callee.object.type === AST_NODE_TYPES.Identifier &&
          GLOBAL_OBJECTS.has(callee.object.name) &&
          callee.property.type === AST_NODE_TYPES.Identifier &&
          TIMERS.has(callee.property.name);
        if (isBare || isGlobal) context.report({ node, messageId: "realTimer" });
      },
      ImportDeclaration(node) {
        if (typeof node.source.value === "string" && TIMER_MODULES.has(node.source.value)) {
          context.report({ node, messageId: "realTimer" });
        }
      },
    };
  },
});
