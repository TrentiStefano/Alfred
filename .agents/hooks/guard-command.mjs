#!/usr/bin/env node
// Antigravity PreToolUse hook for run_command (registered in .agents/hooks.json).
// Denies gh commands that apply `human-approved` or mutate labels.
import { guardCommand } from "../../tools/guardrails/index.ts";

let input = "";
for await (const chunk of process.stdin) input += chunk;

const command = JSON.parse(input.replace(/^\uFEFF/, "")).toolCall?.args?.CommandLine;
const result = typeof command === "string" ? guardCommand(command) : { decision: "allow" };
process.stdout.write(
  JSON.stringify(
    result.decision === "block"
      ? { decision: "deny", reason: result.reason }
      : { decision: "ask" },
  ),
);
