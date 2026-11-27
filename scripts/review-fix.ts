import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function currentBranch(): string {
  return git(["branch", "--show-current"]);
}

function reviewFixPrefix(branch: string): string {
  return `codex/review-fix/${branch}/`;
}

export function assertNoPendingReviewFixes(): void {
  const branch = currentBranch();
  if (branch === "") return;
  const pending = git([
    "for-each-ref",
    "--format=%(refname:short)",
    `refs/heads/${reviewFixPrefix(branch)}`,
  ]);
  if (pending !== "") {
    throw new Error(
      `Review fixes are still checked out or awaiting integration:\n${pending}\n` +
        "Use git worktree list to find the changes. Commit and integrate the fixes, then " +
        "remove the clean worktrees with git worktree remove and the merged branches with git branch -d.",
    );
  }
}

if (import.meta.main) {
  const [name, ...extra] = process.argv.slice(2);
  const branch = currentBranch();
  if (name === undefined || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || extra.length > 0) {
    throw new Error("Usage: node scripts/review-fix.ts <fix-name-in-kebab-case>");
  }
  if (branch === "" || branch === "main" || branch.startsWith("codex/review-fix/")) {
    throw new Error("Run this command from the branch that will receive the review fixes.");
  }
  const worktree = join(
    git(["rev-parse", "--show-toplevel"]),
    ".claude",
    "worktrees",
    `review-fix-${name}-${randomUUID()}`,
  );
  const fixBranch = `${reviewFixPrefix(branch)}${name}`;
  git(["worktree", "add", "-b", fixBranch, "--", worktree]);
  process.stdout.write(
    `Delegate the review fix in ${worktree} (branch ${fixBranch}).\n` +
      "The worktree and branch remain available if the reviewer stops midway.\n",
  );
}
