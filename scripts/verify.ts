// The single gatekeeper. Exits 0 only if every check passes. Run: `pnpm verify` or `./scripts/verify`.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { assertNoPendingReviewFixes } from "./review-fix.ts";

if (process.env.GITHUB_EVENT_NAME === "pull_request" && process.env.GITHUB_EVENT_PATH) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")) as {
    pull_request: { draft: boolean };
  };
  if (event.pull_request.draft) {
    throw new Error("Pull request is a draft. Use gh pr ready to mark it ready for review.");
  }
}

assertNoPendingReviewFixes();

interface Step {
  name: string;
  script: string;
  fix: string;
  filter?: string;
}

const STEPS: readonly Step[] = [
  { name: "format", script: "format:check", fix: "Run `pnpm format` to rewrite the files." },
  { name: "typecheck", script: "typecheck", fix: "Fix the type errors; never add @ts-ignore." },
  {
    name: "lint",
    script: "lint",
    fix: "Follow each rule's message; eslint-disable comments are banned.",
  },
  {
    name: "boundaries",
    script: "lint:boundaries",
    fix: "Import packages only through their entry points and allowed layers (packages/README.md).",
  },
  { name: "test", script: "test", fix: "Make the failing tests pass; do not skip or delete them." },
  {
    name: "flutter:format",
    script: "flutter:format:check",
    fix: "Run `pnpm flutter:format` to rewrite the Dart files.",
  },
  {
    name: "flutter:analyze",
    script: "flutter:analyze",
    fix: "Fix the Dart analyzer findings in apps/client.",
  },
  {
    name: "flutter:test",
    script: "flutter:test",
    fix: "Make the failing Flutter tests pass in apps/client.",
  },
  {
    name: "repo",
    script: "check:repo",
    fix: "Keep local-only config out of git and AGENTS.md short.",
  },
  ...(process.argv.includes("--web-e2e")
    ? [
        {
          name: "web:e2e",
          script: "test:web",
          filter: "@alfred/e2e",
          fix: "Fix the Flutter Web and daemon integration. Install Chromium with Playwright if missing.",
        },
      ]
    : []),
];

const failed: Step[] = [];

for (const step of STEPS) {
  const command = `pnpm -s ${step.filter === undefined ? "" : `--filter ${step.filter} `}run ${step.script}`;
  process.stdout.write(`\n▶ ${step.name} (${command})\n`);
  // One command string (not argv) so the shell resolves pnpm.cmd on Windows without DEP0190.
  const result = spawnSync(command, {
    stdio: "inherit",
    shell: true,
    env: step.name === "web:e2e" ? { ...process.env, ALFRED_E2E_REBUILD: "1" } : process.env,
  });
  if (result.status !== 0) failed.push(step);
}

process.stdout.write("\n");
if (failed.length === 0) {
  process.stdout.write("✔ verify: all checks passed.\n");
} else {
  for (const step of failed) process.stderr.write(`✖ ${step.name}: ${step.fix}\n`);
  process.stderr.write(
    `verify failed (${String(failed.length)}/${String(STEPS.length)} checks).\n`,
  );
  process.exitCode = 1;
}
