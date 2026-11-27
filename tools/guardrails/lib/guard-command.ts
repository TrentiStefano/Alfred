import { APPROVAL_LABEL } from "./approval.ts";

export type GuardDecision = { decision: "allow" } | { decision: "block"; reason: string };

// A word `gh` (or `gh.exe`, possibly behind a path), not part of a longer identifier.
const GH_WORD = /(?<![\w.-])gh(?:\.exe)?(?![\w.-])/gi;

// Tokens after which the next word is in command position.
const COMMAND_START = /[;&|(){}`"'\r\n]$/;

const LAUNCHERS = new Set([
  "sudo",
  "env",
  "exec",
  "command",
  "time",
  "nohup",
  "xargs",
  "npx",
  "pnpx",
  "call",
  "start",
  "start-process",
  "saps",
  "iex",
  "invoke-expression",
  "/c",
  "/k",
]);

const GH_LABEL_SUBCOMMAND = /^\s+label\s+(create|edit|delete)\b/i;

function precededByCommandStart(before: string): boolean {
  if (/[\\/]$/.test(before)) return true;
  const trimmed = before.trimEnd();
  if (trimmed === "" || COMMAND_START.test(trimmed)) return true;
  const previousWord = (trimmed.split(/\s+/).pop() ?? "").toLowerCase();
  return LAUNCHERS.has(previousWord) || previousWord.startsWith("-") || /^\w+=/.test(previousWord);
}

function ghInvocations(command: string): number[] {
  return [...command.matchAll(GH_WORD)]
    .filter((match) => precededByCommandStart(command.slice(0, match.index)))
    .map((match) => match.index + match[0].length);
}

// Strip quotes, escapes, backticks and whitespace that shells drop before reaching `gh`.
function normalize(text: string): string {
  return text.replace(/["'`^\\+\s]/g, "").toLowerCase();
}

/** Decide whether a shell command issued by an agent should be blocked. */
export function guardCommand(command: string): GuardDecision {
  const invocations = ghInvocations(command);
  const firstInvocation = invocations[0];
  if (
    firstInvocation !== undefined &&
    normalize(command.slice(firstInvocation)).includes(APPROVAL_LABEL)
  ) {
    return {
      decision: "block",
      reason:
        `Blocked: agents may not apply the ${APPROVAL_LABEL} label; only the Owner approves in the GitHub UI. ` +
        `If the command only mentions the label in prose (an issue or PR body or comment), write the text to a ` +
        `file and pass it with --body-file instead.`,
    };
  }

  for (const offset of invocations) {
    const match = GH_LABEL_SUBCOMMAND.exec(command.slice(offset).replace(/["'`]/g, ""));
    const subcommand = match?.[1];
    if (subcommand !== undefined) {
      return {
        decision: "block",
        reason: `Blocked: agents may not ${subcommand.toLowerCase()} labels; ask the Owner to change labels in GitHub.`,
      };
    }
  }

  return { decision: "allow" };
}
