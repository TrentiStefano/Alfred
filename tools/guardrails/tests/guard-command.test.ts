import { describe, expect, it } from "vitest";
import { guardCommand } from "../index.ts";

describe("guardCommand", () => {
  it("blocks gh commands that apply or mention human-approved", () => {
    const blocked = [
      "gh pr edit 12 --add-label human-approved",
      'gh pr edit 12 --add-label "human-"approved',
      "bash -c 'gh pr edit 12 --add-label human-approved'",
      "& gh.exe api repos/TrentiStefano/Alfred/issues/12/labels -f labels[]=human-approved",
    ];
    for (const cmd of blocked) {
      expect(guardCommand(cmd).decision, cmd).toBe("block");
    }
  });

  it("blocks gh label create, edit, and delete", () => {
    const blocked = [
      "gh label create human-approved",
      "gh label edit wip --name human-approved",
      "gh label delete wip --yes",
    ];
    for (const cmd of blocked) {
      expect(guardCommand(cmd).decision, cmd).toBe("block");
    }
  });

  it("allows ordinary gh commands, merges, and non-gh commands", () => {
    const allowed = [
      "gh pr create --title 'Add feature' --body-file body.md",
      "gh pr merge 12 --squash --delete-branch",
      "gh issue edit 7 --add-label wayfinder:grilling",
      "gh label list",
      "git commit -m 'docs: explain human-approved flow'",
    ];
    for (const cmd of allowed) {
      expect(guardCommand(cmd).decision, cmd).toBe("allow");
    }
  });
});
