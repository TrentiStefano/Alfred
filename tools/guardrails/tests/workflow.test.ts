import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WORKFLOW = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  ".github",
  "workflows",
  "guardrails-approval.yml",
);

describe("guardrails-approval workflow", () => {
  it("never cancels its own runs, so a cancelled required check cannot block a merge", () => {
    const yaml = readFileSync(WORKFLOW, "utf8");
    // A run of this workflow must always finish: all runs report the same required check on
    // the same commit, and a cancelled one blocks the PR (see the comment in the workflow).
    expect(yaml).not.toMatch(/^\s*concurrency:/m);
    expect(yaml).not.toMatch(/cancel-in-progress:\s*true/);
  });
});
