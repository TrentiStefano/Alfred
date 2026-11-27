// Repo hygiene that no linter covers:
//  1. Machine-specific config and secrets are never tracked (this repo is public).
//  2. AGENTS.md stays a map, not a manual (<= 80 lines).
//  3. Claude Code and Antigravity run the same skills and procedure (scripts/agent-skills.ts).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { skillTreeDrift, workflowDrift } from "./agent-skills.ts";

const AGENTS_MAX_LINES = 80;

/** Paths that must only ever exist locally. `*.example.*` placeholders are always allowed. */
const LOCAL_ONLY: readonly { pattern: RegExp; why: string }[] = [
  { pattern: /(^|\/)\.env(\.[^/]+)?$/, why: "environment file" },
  { pattern: /(^|\/)connectors\.ya?ml$/, why: "real Connector config" },
  { pattern: /(^|\/)(docker-)?compose(\.[^/]+)?\.ya?ml$/, why: "machine-specific compose stack" },
  { pattern: /\.local\.[^/]+$/, why: "local override" },
  { pattern: /(^|\/)secrets\//, why: "secrets folder" },
  { pattern: /(^|\/)auth\.json$/, why: "provider credentials" },
  { pattern: /\.(pem|key|p12|pfx)$/, why: "private key or certificate" },
];

function isExample(path: string): boolean {
  return /\.example(\.[^/]+)?$/.test(path);
}

function candidateFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
  });
  return out.split("\n").filter((line) => line.length > 0);
}

const problems: string[] = [];

for (const path of candidateFiles()) {
  if (isExample(path)) continue;
  const hit = LOCAL_ONLY.find(({ pattern }) => pattern.test(path));
  if (hit !== undefined) {
    problems.push(
      `${path}: looks like a ${hit.why}, which must stay on the Owner's machine. Remove it from git (\`git rm --cached ${path}\`), make sure .gitignore covers it, and commit a placeholder named like \`${path.replace(/(\.[^./]+)?$/, ".example$1")}\` instead.`,
    );
  }
}

const agentsLines = readFileSync("AGENTS.md", "utf8").trimEnd().split("\n").length;
if (agentsLines > AGENTS_MAX_LINES) {
  problems.push(
    `AGENTS.md has ${String(agentsLines)} lines (max ${String(AGENTS_MAX_LINES)}). Keep it a map: move detail into docs/ or a package README and leave a one-line pointer.`,
  );
}

for (const drift of skillTreeDrift()) {
  problems.push(
    `Skill copies drifted: ${drift}. Claude Code (.claude/skills) and Antigravity (.agents/skills) must run identical skills: reinstall both from one commit with \`npx skills@latest add mattpocock/skills -a claude-code -a antigravity --copy -y -s <skills>\`, then \`pnpm skills:sync\`.`,
  );
}
for (const drift of workflowDrift()) {
  problems.push(
    `Antigravity workflow out of sync: ${drift}. Run \`pnpm skills:sync\` (never edit .agents/workflows by hand).`,
  );
}

if (problems.length > 0) {
  process.stderr.write(`check:repo failed:\n- ${problems.join("\n- ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    "check:repo: no local-only files tracked, AGENTS.md within budget, agent skills in sync.\n",
  );
}
