// `pnpm skills:sync`: regenerate Antigravity's `/skill` workflows from the installed skills.
// Install or update the skills themselves for both tools first:
//   npx skills@latest update   (or `add mattpocock/skills -a claude-code -a antigravity --copy ...`)
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ANTIGRAVITY_WORKFLOWS, skillNames, skillTreeDrift, workflowFor } from "./agent-skills.ts";

rmSync(ANTIGRAVITY_WORKFLOWS, { recursive: true, force: true });
mkdirSync(ANTIGRAVITY_WORKFLOWS, { recursive: true });
const names = skillNames();
for (const name of names)
  writeFileSync(join(ANTIGRAVITY_WORKFLOWS, `${name}.md`), workflowFor(name));
process.stdout.write(`skills:sync: wrote ${String(names.length)} Antigravity workflows.\n`);

const drift = skillTreeDrift();
if (drift.length > 0) {
  process.stderr.write(
    `The Claude Code and Antigravity skill copies differ:\n- ${drift.join("\n- ")}\nReinstall both from the same commit: npx skills@latest add mattpocock/skills -a claude-code -a antigravity --copy -y -s <skills>\n`,
  );
  process.exitCode = 1;
}
