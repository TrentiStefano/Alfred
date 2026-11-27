import { describe, expect, it } from "vitest";
import { APPROVAL_LABEL, APPROVAL_MARKER, approvalStatus, guardedKind } from "../index.ts";

describe("guardedKind", () => {
  it("flags methodology, tooling, CI, lint, and root manifest paths", () => {
    const expectedGuarded = [
      "AGENTS.md",
      "CLAUDE.md",
      "skills-lock.json",
      "docs/agents/issue-tracker.md",
      ".agents/skills/grilling/SKILL.md",
      ".agents/hooks.json",
      ".claude/settings.json",
      ".codex/rules/guard.rules",
      "scripts/verify.ts",
      "tools/eslint-plugin-alfred/index.ts",
      "tools/guardrails/lib/approval.ts",
      "eslint.config.ts",
      ".dependency-cruiser.cjs",
      "vitest.config.ts",
      "tsconfig.base.json",
      "packages/protocol/tsconfig.json",
      ".prettierrc.json",
      ".prettierignore",
      "apps/client/analysis_options.yaml",
      ".github/workflows/verify.yml",
      ".gitignore",
      "package.json",
      "pnpm-workspace.yaml",
    ];
    for (const path of expectedGuarded) {
      expect(guardedKind(path), path).toBeDefined();
    }
  });

  it("leaves code, specs, glossary, ADRs, lockfile, and package manifests unguarded", () => {
    const expectedFree = [
      "apps/daemon/lib/describe.ts",
      "apps/client/lib/main.dart",
      "apps/client/pubspec.yaml",
      "packages/protocol/index.ts",
      "packages/connector-caldav/package.json",
      "GLOSSARY.md",
      "docs/adr/0002-flutter-client.md",
      "specs/2026-11-27-slice-1.md",
      "pnpm-lock.yaml",
    ];
    for (const path of expectedFree) {
      expect(guardedKind(path), path).toBeUndefined();
    }
  });
});

describe("approvalStatus", () => {
  it("passes silently when no guarded path changed", () => {
    const result = approvalStatus({
      changedPaths: ["apps/daemon/index.ts", "GLOSSARY.md", "docs/adr/0002-flutter-client.md"],
      eventAction: "opened",
      runCreatedAt: "2026-11-27T09:00:00Z",
    });
    expect(result.status).toBe("not-needed");
    expect(result.comment).toBeNull();
  });

  it("updates an existing comment when a guarded change is reverted", () => {
    const result = approvalStatus({
      changedPaths: ["apps/daemon/index.ts"],
      previousComment: `${APPROVAL_MARKER}\n**Guardrail approval needed.**`,
    });
    expect(result.status).toBe("not-needed");
    expect(result.comment).toContain("not needed");
  });

  it("requires approval when a guarded path changed without the label", () => {
    const result = approvalStatus({
      changedPaths: ["scripts/verify.ts", "AGENTS.md"],
      eventAction: "opened",
      runCreatedAt: "2026-11-27T09:00:00Z",
    });
    expect(result.status).toBe("needed");
    expect(result.stale).toBe(false);
    expect(result.reasons).toEqual([
      "agent instructions changed: `AGENTS.md`",
      "verification / repo script changed: `scripts/verify.ts`",
    ]);
    expect(result.comment).toContain(APPROVAL_LABEL);
  });

  it("approves when the label was added after the latest push", () => {
    const result = approvalStatus({
      changedPaths: [".github/workflows/verify.yml"],
      eventAction: "labeled",
      verifyRunTimes: ["2026-11-27T09:00:00Z"],
      labelEvents: [
        {
          action: "labeled",
          label: APPROVAL_LABEL,
          at: "2026-11-27T09:05:00Z",
          actor: "TrentiStefano",
        },
      ],
    });
    expect(result.status).toBe("approved");
    expect(result.stale).toBe(false);
    expect(result.comment).toContain("@TrentiStefano");
  });

  it("marks approval stale when a commit is pushed after the label", () => {
    const result = approvalStatus({
      changedPaths: ["eslint.config.ts"],
      eventAction: "synchronize",
      runCreatedAt: "2026-11-27T09:10:00Z",
      labelEvents: [
        {
          action: "labeled",
          label: APPROVAL_LABEL,
          at: "2026-11-27T09:05:00Z",
        },
      ],
    });
    expect(result.status).toBe("needed");
    expect(result.stale).toBe(true);
    expect(result.comment).toContain("stale");
  });

  it("treats the label as stale when the push time is unknown", () => {
    const result = approvalStatus({
      changedPaths: ["AGENTS.md"],
      eventAction: "labeled",
      labelEvents: [{ action: "labeled", label: APPROVAL_LABEL, at: "2026-11-27T09:05:00Z" }],
    });
    expect(result.status).toBe("needed");
    expect(result.stale).toBe(true);
  });
});
