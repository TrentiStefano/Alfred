#!/usr/bin/env node
// Claude Code PreToolUse hook for Bash and PowerShell tools.
// Denies gh commands that apply `human-approved` or mutate labels.
import { guardCommand } from "../../tools/guardrails/index.ts";

let input = "";
for await (const chunk of process.stdin) input += chunk;

const command = JSON.parse(input.replace(/^\uFEFF/, "")).tool_input?.command;
if (typeof command === "string") {
  const result = guardCommand(command);
  if (result.decision === "block") {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: result.reason,
        },
      }),
    );
  }
}
