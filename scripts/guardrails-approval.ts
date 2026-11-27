// Runs in CI (`.github/workflows/guardrails-approval.yml`) on every pull-request event and locally for dry runs:
//   node scripts/guardrails-approval.ts --base origin/main --head HEAD
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  APPROVAL_LABEL,
  APPROVAL_MARKER,
  approvalStatus,
  type LabelEvent,
} from "../tools/guardrails/index.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function git(...args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: REPO,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function str(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function nestedStr(
  record: Record<string, unknown>,
  key: string,
  child: string,
): string | undefined {
  const nested = record[key];
  return isRecord(nested) ? str(nested, child) : undefined;
}

const env = process.env;
const ci = Boolean(env.GITHUB_TOKEN && env.PR_NUMBER && env.GITHUB_REPOSITORY);
const baseRev = ci ? (env.BASE_SHA ?? "origin/main") : (argValue("--base") ?? "origin/main");
const headRev = ci ? (env.HEAD_SHA ?? "HEAD") : (argValue("--head") ?? "HEAD");

const mergeBase = git("merge-base", baseRev, headRev).trim();
const changedPaths = git("diff", "--name-only", "--no-renames", "-z", mergeBase, headRev)
  .split("\0")
  .filter((p) => p.length > 0);

const apiBase = env.GITHUB_API_URL || "https://api.github.com";

async function api(
  method: string,
  route: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const token = env.GITHUB_TOKEN ?? "";
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
  if (body !== undefined) headers["content-type"] = "application/json";

  const res = await fetch(`${apiBase}${route}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : null,
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    throw new Error(`${method} ${route}: HTTP ${String(res.status)} ${text}`);
  }
  return res.status === 204 ? null : res.json();
}

async function paged(route: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let page = 1; ; page += 1) {
    const sep = route.includes("?") ? "&" : "?";
    const data = await api("GET", `${route}${sep}per_page=100&page=${String(page)}`);
    let rawList: unknown[] = [];
    if (Array.isArray(data)) {
      rawList = data;
    } else if (isRecord(data) && Array.isArray(data.workflow_runs)) {
      rawList = data.workflow_runs;
    }
    const items = rawList.filter(isRecord);
    out.push(...items);
    if (rawList.length < 100) return out;
  }
}

async function tryRead<T>(what: string, read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`! could not read ${what} (${message}).`);
    return fallback;
  }
}

const labelEvents: LabelEvent[] = [];
let runCreatedAt: string | undefined;
let verifyRunTimes: string[] = [];
let botComment: { id: number; body: string } | undefined;

const repo = `/repos/${env.GITHUB_REPOSITORY ?? ""}`;
const prNumber = env.PR_NUMBER ?? "";

if (ci) {
  const events = await paged(`${repo}/issues/${prNumber}/events`);
  for (const event of events) {
    const kind = str(event, "event");
    const label = nestedStr(event, "label", "name");
    const at = str(event, "created_at");
    if ((kind === "labeled" || kind === "unlabeled") && label !== undefined && at !== undefined) {
      const actor = nestedStr(event, "actor", "login");
      labelEvents.push(
        actor !== undefined ? { action: kind, label, at, actor } : { action: kind, label, at },
      );
    }
  }

  const runId = env.GITHUB_RUN_ID;
  if (runId) {
    runCreatedAt = await tryRead(
      "this run's creation time",
      async () => {
        const run = await api("GET", `${repo}/actions/runs/${runId}`);
        return isRecord(run) ? str(run, "created_at") : undefined;
      },
      undefined,
    );
  }

  verifyRunTimes = await tryRead(
    "the verify.yml runs",
    async () => {
      const runs = await paged(
        `${repo}/actions/workflows/verify.yml/runs?event=pull_request&head_sha=${headRev}`,
      );
      return runs.map((run) => str(run, "created_at")).filter((t): t is string => t !== undefined);
    },
    [],
  );

  const comments = await tryRead(
    "the PR comments",
    () => paged(`${repo}/issues/${prNumber}/comments`),
    [],
  );
  for (const comment of comments) {
    const userType = nestedStr(comment, "user", "type");
    const body = str(comment, "body");
    const id = comment.id;
    if (
      userType === "Bot" &&
      body !== undefined &&
      body.startsWith(APPROVAL_MARKER) &&
      typeof id === "number"
    ) {
      botComment = { id, body };
      break;
    }
  }
}

const result = approvalStatus({
  changedPaths,
  labelEvents,
  ...(env.EVENT_ACTION !== undefined ? { eventAction: env.EVENT_ACTION } : {}),
  ...(runCreatedAt !== undefined ? { runCreatedAt } : {}),
  verifyRunTimes,
  previousComment: botComment?.body ?? null,
});

console.log(`Guardrail approval: ${result.status}${result.stale ? " (stale label)" : ""}`);
console.log(
  `  compared ${headRev} with merge base ${mergeBase.slice(0, 12)}; latest push: ${result.latestPushAt ?? "unknown"}`,
);
for (const reason of result.reasons) console.log(`  - ${reason}`);
if (result.comment !== null) console.log(`\n${result.comment}\n`);

if (ci) {
  try {
    if (result.comment !== null) {
      if (botComment !== undefined && botComment.body !== result.comment) {
        await api("PATCH", `${repo}/issues/comments/${String(botComment.id)}`, {
          body: result.comment,
        });
      } else if (botComment === undefined) {
        await api("POST", `${repo}/issues/${prNumber}/comments`, { body: result.comment });
      }
    }
    if (result.stale && result.latestPushAt !== null) {
      await api(
        "DELETE",
        `${repo}/issues/${prNumber}/labels/${encodeURIComponent(APPROVAL_LABEL)}`,
      );
      console.log(`Removed the stale ${APPROVAL_LABEL} label.`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `! could not update the PR comment or labels (${message}); the check result still applies.`,
    );
  }
}

if (result.status === "needed") {
  console.error(
    `✖ Guardrail approval needed: the Owner must add the ${APPROVAL_LABEL} label after reviewing.`,
  );
  process.exitCode = 1;
}
