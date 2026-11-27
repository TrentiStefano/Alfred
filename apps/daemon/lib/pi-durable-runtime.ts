import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  type AssistantMessage,
  type Models,
  type UserMessage,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  AssistantEntry,
  Harness,
  LiveDoc,
  UserEntry,
  createRegistry,
  type AgentChange,
  type Conversation,
  type Cursor,
  type EntryRecord,
  type HarnessSettings,
  type LiveState,
  type ModelRef,
  type RunFailure,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  DEFAULT_MAIN_THREAD_ID,
  type ThreadMessage,
  type ThreadMessageStatus,
  type ThreadSnapshot,
  type ThreadStatus,
} from "@alfred/protocol";
import { loadMainAgentDefinition } from "./agent-config.ts";
import {
  AgentRuntimeError,
  type AgentRuntime,
  type SubmitInput,
  type SubmitResult,
} from "./agent-runtime.ts";
import { sanitizeErrorMessage } from "./sanitize-error.ts";

const ALFRED_USER_ENTRY_KIND = "alfred.user";
const ENTRY_SCAN_PAGE_SIZE = 256;

export interface AgentModelRef {
  provider: string;
  modelId: string;
}

export interface AgentRetryOptions {
  enabled?: boolean;
  maxRetries?: number;
  baseDelayMs?: number;
  maxAgentDelayMs?: number;
}

export interface PiDurableAgentRuntimeOptions {
  sqlitePath: string;
  threadId?: string;
  agentDefinitionPath?: string;
  agentsDir?: string;
  models?: Models | (() => Models | Promise<Models>);
  model?: AgentModelRef;
  retry?: AgentRetryOptions;
  sqlitePrefix?: string;
}

function extractUserText(message: UserMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  return message.content
    .filter(
      (block): block is Extract<(typeof message.content)[number], { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("");
}

function extractAssistantText(content: AssistantMessage["content"]): string {
  return content
    .filter(
      (block): block is Extract<AssistantMessage["content"][number], { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("");
}

function extractRequestId(data: EntryRecord["data"]): string | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return undefined;
  }
  const value = data.requestId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function resolveModelRef(spec: string | undefined, models: Models): ModelRef | undefined {
  if (spec === undefined) {
    return undefined;
  }
  const trimmed = spec.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex > 0 && slashIndex < trimmed.length - 1) {
    return {
      provider: trimmed.slice(0, slashIndex),
      modelId: trimmed.slice(slashIndex + 1),
    };
  }
  const match = models.getModels().find((candidate) => candidate.id === trimmed);
  if (match !== undefined) {
    return { provider: match.provider, modelId: match.id };
  }
  return { provider: "unconfigured", modelId: trimmed };
}

function formatRunFailureMessage(failure: RunFailure, modelsInitError: string | undefined): string {
  if (failure.reason === "no_model" && modelsInitError !== undefined) {
    return sanitizeErrorMessage(modelsInitError, "Model configuration could not be loaded.");
  }
  switch (failure.reason) {
    case "model_error":
    case "no_model":
    case "faulted":
    case "interrupted":
    case "restart_limit":
    case "turn_limit":
      return sanitizeErrorMessage(failure.detail ?? "", "Model request failed.");
    case "aborted":
      return sanitizeErrorMessage(failure.detail ?? "", "Response interrupted.");
    case "reset":
      return "Thread was reset before the response completed.";
    case "orphaned":
      return "Run could not resume after restart.";
    case "nothing_to_answer":
      return "Nothing to answer.";
  }
}

function mapEntriesToMessages(
  entries: readonly EntryRecord[],
  live: LiveState | undefined,
  modelsInitError: string | undefined,
): ThreadMessage[] {
  const messages: ThreadMessage[] = [];
  let lastTerminalAssistantEntryId: number | undefined;
  let lastCreatedAt: string | undefined;

  for (const entry of entries) {
    if (entry.kind === ALFRED_USER_ENTRY_KIND || UserEntry.is(entry)) {
      const userMsg = entry.model?.[0];
      if (userMsg?.role !== "user") {
        continue;
      }
      const createdAt = new Date(userMsg.timestamp).toISOString();
      lastCreatedAt = createdAt;
      const requestId = extractRequestId(entry.data);
      messages.push({
        id: `entry-${String(entry.id)}`,
        role: "owner",
        text: extractUserText(userMsg),
        status: "complete",
        ...(requestId !== undefined ? { requestId } : {}),
        createdAt,
      });
      continue;
    }

    if (AssistantEntry.is(entry)) {
      const assistantMsg = entry.model?.[0];
      if (assistantMsg?.role !== "assistant") {
        continue;
      }
      const createdAt = new Date(assistantMsg.timestamp).toISOString();
      lastCreatedAt = createdAt;
      const text = extractAssistantText(assistantMsg.content);

      let status: ThreadMessageStatus;
      let displayText: string;
      if (assistantMsg.stopReason === "error") {
        status = "error";
        const rawError =
          text.trim().length > 0 ? text : (assistantMsg.errorMessage ?? "Model request failed.");
        displayText = sanitizeErrorMessage(rawError);
        lastTerminalAssistantEntryId = entry.id;
      } else if (assistantMsg.stopReason === "aborted") {
        status = "interrupted";
        const rawAborted =
          text.trim().length > 0 ? text : (assistantMsg.errorMessage ?? "Response interrupted.");
        displayText = sanitizeErrorMessage(rawAborted, "Response interrupted.");
        lastTerminalAssistantEntryId = entry.id;
      } else if (assistantMsg.stopReason === "toolUse" && text.trim().length === 0) {
        continue;
      } else {
        status = "complete";
        displayText = text;
        lastTerminalAssistantEntryId = entry.id;
      }

      messages.push({
        id: `entry-${String(entry.id)}`,
        role: "agent",
        text: displayText,
        status,
        createdAt,
      });
    }
  }

  if (live?.run !== undefined && live.generation?.message !== undefined) {
    const partialText = extractAssistantText(live.generation.message.content);
    if (partialText.length > 0) {
      messages.push({
        id: `live-gen-${String(live.run.taskId)}`,
        role: "agent",
        text: partialText,
        status: "streaming",
        createdAt: new Date(live.generation.message.timestamp).toISOString(),
      });
    }
  }

  if (live?.runFailure !== undefined) {
    const failureFirst = live.runFailure.first;
    const failureAlreadyInTranscript =
      failureFirst !== undefined &&
      lastTerminalAssistantEntryId !== undefined &&
      lastTerminalAssistantEntryId >= failureFirst;

    if (!failureAlreadyInTranscript) {
      const status: ThreadMessageStatus =
        live.runFailure.reason === "aborted" || live.runFailure.reason === "interrupted"
          ? "interrupted"
          : "error";
      messages.push({
        id: `failure-${String(live.runFailure.taskId)}`,
        role: "agent",
        text: formatRunFailureMessage(live.runFailure, modelsInitError),
        status,
        createdAt: lastCreatedAt ?? new Date().toISOString(),
      });
    }
  }

  return messages;
}

function deriveThreadStatus(live: LiveState | undefined): ThreadStatus {
  if (live?.run !== undefined) {
    return "streaming";
  }
  if (live?.runFailure !== undefined) {
    return "error";
  }
  return "idle";
}

async function readAllEntries(conversation: Conversation): Promise<EntryRecord[]> {
  const entries: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await conversation.entries(
      { order: "ascending" },
      ENTRY_SCAN_PAGE_SIZE,
      cursor,
      BACKGROUND_CONTEXT,
    );
    entries.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return entries;
}

function buildHarnessSettings(retry: AgentRetryOptions | undefined): HarnessSettings | undefined {
  if (retry === undefined) {
    return undefined;
  }
  return {
    retry: {
      ...(retry.enabled !== undefined ? { enabled: retry.enabled } : {}),
      ...(retry.maxRetries !== undefined ? { maxRetries: retry.maxRetries } : {}),
      ...(retry.baseDelayMs !== undefined ? { baseDelayMs: retry.baseDelayMs } : {}),
      ...(retry.maxAgentDelayMs !== undefined ? { maxAgentDelayMs: retry.maxAgentDelayMs } : {}),
    },
  };
}

/** Create a Pi Durable-backed `AgentRuntime` for the Main Agent persisted in SQLite. */
export async function createPiDurableAgentRuntime(
  options: PiDurableAgentRuntimeOptions,
): Promise<AgentRuntime> {
  const mainThreadId = options.threadId ?? DEFAULT_MAIN_THREAD_ID;
  const agentDef = loadMainAgentDefinition({
    ...(options.agentDefinitionPath !== undefined
      ? { explicitPath: options.agentDefinitionPath }
      : {}),
    ...(options.agentsDir !== undefined ? { agentsDir: options.agentsDir } : {}),
  });

  let currentModels: Models = createModels();
  let modelsInitialized = false;
  let modelsInitError: string | undefined;

  const modelsSource = options.models ?? (() => ModelRuntime.create());
  async function ensureModelsLoaded(): Promise<void> {
    if (modelsInitialized) {
      return;
    }
    if (typeof modelsSource !== "function") {
      currentModels = modelsSource;
      modelsInitialized = true;
      modelsInitError = undefined;
      return;
    }
    try {
      currentModels = await modelsSource();
      modelsInitialized = true;
      modelsInitError = undefined;
    } catch (error) {
      modelsInitError = sanitizeErrorMessage(
        error instanceof Error ? error.message : String(error),
        "Model runtime initialization failed.",
      );
    }
  }

  await ensureModelsLoaded();

  if (options.sqlitePath !== ":memory:") {
    mkdirSync(dirname(options.sqlitePath), { recursive: true });
  }

  const storage = await openNodeSqliteStorage(
    options.sqlitePath,
    options.sqlitePrefix !== undefined ? { prefix: options.sqlitePrefix } : undefined,
  );

  const settings = buildHarnessSettings(options.retry);
  const harness = await Harness.open(
    storage,
    {
      models: () => currentModels,
      registry: createRegistry(),
      ...(settings !== undefined ? { settings } : {}),
    },
    BACKGROUND_CONTEXT,
  );

  const conversation = await harness.root(BACKGROUND_CONTEXT);

  const configuredModel =
    options.model !== undefined
      ? { provider: options.model.provider, modelId: options.model.modelId }
      : resolveModelRef(agentDef.model, currentModels);

  const agentChange: AgentChange = {
    instructions: agentDef.instructions.length > 0 ? agentDef.instructions : null,
    model: configuredModel ?? null,
  };
  await conversation.configure(agentChange, BACKGROUND_CONTEXT);
  harness.resume();

  let closePromise: Promise<void> | undefined;

  async function buildSnapshot(): Promise<ThreadSnapshot> {
    const [entries, live] = await Promise.all([
      readAllEntries(conversation),
      harness.snapshot(LiveDoc, conversation.id, BACKGROUND_CONTEXT),
    ]);
    return {
      id: mainThreadId,
      agentName: agentDef.name,
      status: deriveThreadStatus(live),
      messages: mapEntriesToMessages(entries, live, modelsInitError),
    };
  }

  return {
    async getSnapshot(threadId = mainThreadId): Promise<ThreadSnapshot> {
      if (threadId !== mainThreadId) {
        throw new AgentRuntimeError("unknown_thread", `Unknown thread "${threadId}".`, {
          threadId,
        });
      }
      return buildSnapshot();
    },

    async submit(input: SubmitInput): Promise<SubmitResult> {
      if (input.threadId !== mainThreadId) {
        throw new AgentRuntimeError("unknown_thread", `Unknown thread "${input.threadId}".`, {
          threadId: input.threadId,
          requestId: input.requestId,
        });
      }

      await ensureModelsLoaded();

      const admission = await conversation.commit(async (tx) => {
        const existing = await tx.submissionByRequest(conversation.id, input.requestId);
        if (existing !== undefined) {
          if (existing.type !== "input") {
            throw new AgentRuntimeError(
              "invalid_state",
              `Request "${input.requestId}" already identifies a non-input submission.`,
              { threadId: input.threadId, requestId: input.requestId },
            );
          }
          return { submissionId: existing.id, deduplicated: true };
        }

        const submissionId = await conversation.admit(tx, {
          type: "input",
          content: input.text,
          requestId: input.requestId,
          entry: {
            kind: ALFRED_USER_ENTRY_KIND,
            data: { requestId: input.requestId },
          },
        });
        return { submissionId, deduplicated: false };
      }, BACKGROUND_CONTEXT);

      const submission = await harness.submission(admission.submissionId, BACKGROUND_CONTEXT);
      if (submission !== undefined) {
        await submission.wait(BACKGROUND_CONTEXT);
      }

      const snapshot = await buildSnapshot();
      return {
        threadId: input.threadId,
        requestId: input.requestId,
        submissionId: String(admission.submissionId),
        deduplicated: admission.deduplicated,
        snapshot,
      };
    },

    close(): Promise<void> {
      closePromise ??= harness.close(BACKGROUND_CONTEXT);
      return closePromise;
    },
  };
}
