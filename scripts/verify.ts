// The single gatekeeper. Exits 0 only if every check passes. Run: `pnpm verify` or `./scripts/verify`.
import { spawnSync } from "node:child_process";

interface Step {
  name: string;
  script: string;
  fix: string;
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
];

const failed: Step[] = [];

for (const step of STEPS) {
  process.stdout.write(`\n▶ ${step.name} (pnpm ${step.script})\n`);
  // One command string (not argv) so the shell resolves pnpm.cmd on Windows without DEP0190.
  const result = spawnSync(`pnpm -s run ${step.script}`, { stdio: "inherit", shell: true });
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
