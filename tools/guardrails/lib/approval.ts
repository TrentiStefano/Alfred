export const APPROVAL_LABEL = "human-approved";
export const APPROVAL_MARKER = "<!-- guardrails-approval -->";

export interface LabelEvent {
  action: "labeled" | "unlabeled";
  label: string;
  at: string;
  actor?: string;
}

export type ApprovalStatusKind = "not-needed" | "needed" | "approved";

export interface ApprovalInput {
  changedPaths: readonly string[];
  labelEvents?: readonly LabelEvent[];
  eventAction?: string;
  runCreatedAt?: string;
  verifyRunTimes?: readonly string[];
  previousComment?: string | null;
}

export interface ApprovalResult {
  status: ApprovalStatusKind;
  reasons: string[];
  stale: boolean;
  latestPushAt: string | null;
  comment: string | null;
}

const PUSH_ACTIONS = new Set(["opened", "synchronize", "reopened"]);

const ROOT_GUARDED_FILES = new Map<string, string>([
  ["AGENTS.md", "agent instructions"],
  ["CLAUDE.md", "agent instructions"],
  ["skills-lock.json", "agent skills lock"],
  [".dependency-cruiser.cjs", "module boundary config"],
  [".gitignore", "git ignore rules"],
  ["package.json", "root workspace manifest"],
  ["pnpm-workspace.yaml", "workspace config"],
]);

const GUARDED_DIRS: readonly { prefix: string; kind: string }[] = [
  { prefix: "docs/agents/", kind: "agent config docs" },
  { prefix: ".agents/", kind: "agent config / hooks" },
  { prefix: ".claude/", kind: "agent config / hooks" },
  { prefix: ".codex/", kind: "agent config / hooks" },
  { prefix: "scripts/", kind: "verification / repo script" },
  { prefix: "tools/eslint-plugin-alfred/", kind: "custom eslint rules" },
  { prefix: "tools/guardrails/", kind: "guardrail tooling" },
  { prefix: ".github/", kind: "CI / GitHub config" },
];

const NOT_NEEDED_ANY_MORE =
  `${APPROVAL_MARKER}\n**Guardrail approval: not needed.** Nothing in this pull request changes a guarded ` +
  `file any more.`;

function toPosix(path: string): string {
  return path.replaceAll("\\", "/");
}

function basename(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

/** Why a path is guarded, or undefined when changing it needs no human approval. */
export function guardedKind(rawPath: string): string | undefined {
  const path = toPosix(rawPath);
  const rootKind = ROOT_GUARDED_FILES.get(path);
  if (rootKind !== undefined) return rootKind;

  for (const { prefix, kind } of GUARDED_DIRS) {
    if (path.startsWith(prefix)) return kind;
  }

  const name = basename(path);
  if (name === "analysis_options.yaml") return "Dart analyzer options";
  if (/^tsconfig.*\.json$/.test(name)) return "TypeScript config";
  if (/^\.prettierrc(\..+)?$/.test(name) || name === ".prettierignore") return "formatter config";
  if (/^(\.eslintrc(\..+)?|\.eslintignore|eslint\.config\.[cm]?[jt]s)$/.test(name)) {
    return "linter config";
  }
  if (/^vitest\.config\.[cm]?[jt]s$/.test(name)) return "test runner config";

  return undefined;
}

/** Sorted list of human-readable reasons for guarded paths in `changedPaths`. */
export function guardedChanges(changedPaths: readonly string[]): string[] {
  const paths = [...new Set(changedPaths.map(toPosix))].sort();
  return paths.flatMap((path) => {
    const kind = guardedKind(path);
    return kind === undefined ? [] : [`${kind} changed: \`${path}\``];
  });
}

function currentLabel(labelEvents: readonly LabelEvent[]): LabelEvent | undefined {
  let current: LabelEvent | undefined;
  const sorted = [...labelEvents].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const event of sorted) {
    if (event.label.toLowerCase() !== APPROVAL_LABEL) continue;
    current = event.action === "labeled" ? event : undefined;
  }
  return current;
}

function latestPush(
  eventAction: string | undefined,
  runCreatedAt: string | undefined,
  verifyRunTimes: readonly string[],
): string | null {
  const candidates = [
    ...(eventAction !== undefined && PUSH_ACTIONS.has(eventAction) ? [runCreatedAt] : []),
    ...verifyRunTimes,
  ].filter((t): t is string => typeof t === "string" && !Number.isNaN(Date.parse(t)));

  candidates.sort((a, b) => Date.parse(a) - Date.parse(b));
  return candidates.at(-1) ?? null;
}

/** Decide whether a PR needs `human-approved` and build the synced PR comment body. */
export function approvalStatus(input: ApprovalInput): ApprovalResult {
  const reasons = guardedChanges(input.changedPaths);
  const latestPushAt = latestPush(
    input.eventAction,
    input.runCreatedAt,
    input.verifyRunTimes ?? [],
  );

  if (reasons.length === 0) {
    const comment = input.previousComment ? NOT_NEEDED_ANY_MORE : null;
    return { status: "not-needed", reasons, stale: false, latestPushAt, comment };
  }

  const list = reasons.map((reason) => `- ${reason}`);
  const label = currentLabel(input.labelEvents ?? []);
  const pushedAt = latestPushAt !== null ? Date.parse(latestPushAt) : Number.NaN;

  if (label !== undefined && Date.parse(label.at) > pushedAt) {
    const by = label.actor ? ` by @${label.actor}` : "";
    const comment = [
      APPROVAL_MARKER,
      `**Guardrail approval: approved${by}** (label \`${APPROVAL_LABEL}\` added ${label.at}, after the latest push).`,
      "",
      "Approved changes:",
      ...list,
      "",
      "A new push makes this approval stale.",
    ].join("\n");
    return { status: "approved", reasons, stale: false, latestPushAt, comment };
  }

  const stale = label !== undefined;
  const staleNotice =
    label !== undefined
      ? [
          `The approval is **stale**: the label was added ${label.at}, before the latest push` +
            `${latestPushAt !== null ? ` (${latestPushAt})` : " (time unknown)"}. Review the new commits, then ` +
            `remove and add the label again (this job removes stale labels automatically when it can).`,
          "",
        ]
      : [];

  const comment = [
    APPROVAL_MARKER,
    `**Guardrail approval needed.** This pull request changes guarded methodology, tooling, or agent files; ` +
      `the Owner must review it and add the \`${APPROVAL_LABEL}\` label:`,
    "",
    ...list,
    "",
    ...staleNotice,
    "Adding the label re-runs this check; no new push is needed.",
  ].join("\n");

  return { status: "needed", reasons, stale, latestPushAt, comment };
}
