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
  type DeltaEvent,
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
  type ThreadDeltaEvent,
  type ThreadSubscription,
} from "./agent-runtime.ts";
import { sanitizeErrorMessage } from "./sanitize-error.ts";

const ALFRED_USER_ENTRY_KIND = "alfred.user";
const ENTRY_SCAN_PAGE_SIZE = 256;
const WATCH_WINDOW_MIN = 200;
const WATCH_WINDOW_MAX = 400;

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

export interface AgentProgressOptions {
  partialIntervalMs?: number;
  outputIntervalMs?: number;
  persistWithinMs?: number;
}

export interface PiDurableAgentRuntimeOptions {
  sqlitePath: string;
  threadId?: string;
  agentDefinitionPath?: string;
  agentsDir?: string;
  models?: Models | (() => Models | Promise<Models>);
  model?: AgentModelRef;
  retry?: AgentRetryOptions;
  progress?: AgentProgressOptions;
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
        id: `live-gen-${String(live.run.taskId)}-a${String(live.generation.attempt)}`,
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

function buildHarnessSettings(
  retry: AgentRetryOptions | undefined,
  progress: AgentProgressOptions | undefined,
): HarnessSettings | undefined {
  if (retry === undefined && progress === undefined) {
    return undefined;
  }
  return {
    ...(retry !== undefined
      ? {
          retry: {
            ...(retry.enabled !== undefined ? { enabled: retry.enabled } : {}),
            ...(retry.maxRetries !== undefined ? { maxRetries: retry.maxRetries } : {}),
            ...(retry.baseDelayMs !== undefined ? { baseDelayMs: retry.baseDelayMs } : {}),
            ...(retry.maxAgentDelayMs !== undefined
              ? { maxAgentDelayMs: retry.maxAgentDelayMs }
              : {}),
          },
        }
      : {}),
    ...(progress !== undefined
      ? {
          progress: {
            ...(progress.partialIntervalMs !== undefined
              ? { partialIntervalMs: progress.partialIntervalMs }
              : {}),
            ...(progress.outputIntervalMs !== undefined
              ? { outputIntervalMs: progress.outputIntervalMs }
              : {}),
            ...(progress.persistWithinMs !== undefined
              ? { persistWithinMs: progress.persistWithinMs }
              : {}),
          },
        }
      : {}),
  };
}

interface ActiveGenerationState {
  taskId: string;
  attempt: number;
  messageId: string;
  emittedText: string;
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

  const settings = buildHarnessSettings(options.retry, options.progress);
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

  const watch = await conversation.watch(BACKGROUND_CONTEXT, {
    min: WATCH_WINDOW_MIN,
    max: WATCH_WINDOW_MAX,
  });

  let cachedEntries: EntryRecord[] =
    watch.value.before !== undefined
      ? await readAllEntries(conversation)
      : [...watch.value.entries];
  let cachedLive = watch.value.docs["pi.live"] as LiveState | undefined;

  const listeners = new Set<(delta: ThreadDeltaEvent) => void>();
  let seq = 0;
  let lastProcessedEntryId = 0;
  let lastTerminalAssistantEntryId: number | undefined;
  let lastCreatedAt: string | undefined;
  let activeGeneration: ActiveGenerationState | undefined;
  let lastEmittedFailureTaskId: string | undefined;

  // Seed state from persisted transcript before starting the live watcher.
  for (const entry of cachedEntries) {
    lastProcessedEntryId = Math.max(lastProcessedEntryId, entry.id);
    if (entry.kind === ALFRED_USER_ENTRY_KIND || UserEntry.is(entry)) {
      const userMsg = entry.model?.[0];
      if (userMsg?.role === "user") {
        lastCreatedAt = new Date(userMsg.timestamp).toISOString();
      }
      continue;
    }
    if (AssistantEntry.is(entry)) {
      const assistantMsg = entry.model?.[0];
      if (assistantMsg?.role !== "assistant") {
        continue;
      }
      lastCreatedAt = new Date(assistantMsg.timestamp).toISOString();
      const text = extractAssistantText(assistantMsg.content);
      if (assistantMsg.stopReason !== "toolUse" || text.trim().length > 0) {
        lastTerminalAssistantEntryId = entry.id;
      }
    }
  }
  if (cachedLive?.run !== undefined && cachedLive.generation?.message !== undefined) {
    const partialText = extractAssistantText(cachedLive.generation.message.content);
    if (partialText.length > 0) {
      const taskId = String(cachedLive.run.taskId);
      const attempt = cachedLive.generation.attempt;
      activeGeneration = {
        taskId,
        attempt,
        messageId: `live-gen-${taskId}-a${String(attempt)}`,
        emittedText: partialText,
      };
    }
  }
  if (cachedLive?.runFailure !== undefined) {
    lastEmittedFailureTaskId = String(cachedLive.runFailure.taskId);
  }

  function emitDelta(event: DeltaEvent): void {
    seq += 1;
    const payload: ThreadDeltaEvent = {
      threadId: mainThreadId,
      seq,
      event,
    };
    for (const listener of listeners) {
      listener(payload);
    }
  }

  function processViewChange(
    entries: readonly EntryRecord[],
    before: number | undefined,
    live: LiveState | undefined,
  ): void {
    if (entries.length > 0) {
      const firstId = entries[0]?.id;
      if (firstId !== undefined) {
        cachedEntries = [...cachedEntries.filter((entry) => entry.id < firstId), ...entries];
      }
    } else if (before === undefined) {
      cachedEntries = [];
    }
    cachedLive = live;

    for (const entry of entries) {
      if (entry.id <= lastProcessedEntryId) {
        continue;
      }
      lastProcessedEntryId = entry.id;

      if (entry.kind === ALFRED_USER_ENTRY_KIND || UserEntry.is(entry)) {
        const userMsg = entry.model?.[0];
        if (userMsg?.role !== "user") {
          continue;
        }
        const createdAt = new Date(userMsg.timestamp).toISOString();
        lastCreatedAt = createdAt;
        const messageId = `entry-${String(entry.id)}`;
        const requestId = extractRequestId(entry.data);
        emitDelta({
          kind: "turn_start",
          messageId,
          role: "owner",
          text: extractUserText(userMsg),
          ...(requestId !== undefined ? { requestId } : {}),
          createdAt,
        });
        emitDelta({
          kind: "turn_finish",
          messageId,
          status: "complete",
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

        if (assistantMsg.stopReason === "toolUse" && text.trim().length === 0) {
          if (activeGeneration !== undefined) {
            emitDelta({
              kind: "turn_finish",
              messageId: activeGeneration.messageId,
              status: "complete",
            });
            activeGeneration = undefined;
          }
          continue;
        }

        const messageId = activeGeneration?.messageId ?? `entry-${String(entry.id)}`;
        if (activeGeneration === undefined) {
          emitDelta({
            kind: "turn_start",
            messageId,
            role: "agent",
            createdAt,
          });
        }

        if (assistantMsg.stopReason === "error") {
          const rawError =
            text.trim().length > 0 ? text : (assistantMsg.errorMessage ?? "Model request failed.");
          emitDelta({
            kind: "turn_error",
            messageId,
            status: "error",
            message: sanitizeErrorMessage(rawError),
          });
        } else if (assistantMsg.stopReason === "aborted") {
          const rawAborted =
            text.trim().length > 0 ? text : (assistantMsg.errorMessage ?? "Response interrupted.");
          emitDelta({
            kind: "turn_error",
            messageId,
            status: "interrupted",
            message: sanitizeErrorMessage(rawAborted, "Response interrupted."),
          });
        } else {
          const alreadyEmitted = activeGeneration?.emittedText ?? "";
          const remaining = text.startsWith(alreadyEmitted)
            ? text.slice(alreadyEmitted.length)
            : text;
          if (remaining.length > 0) {
            emitDelta({
              kind: "text_delta",
              messageId,
              delta: remaining,
            });
          }
          emitDelta({
            kind: "turn_finish",
            messageId,
            status: "complete",
          });
        }

        lastTerminalAssistantEntryId = entry.id;
        activeGeneration = undefined;
      }
    }

    if (live?.run !== undefined && live.generation?.message !== undefined) {
      const partialText = extractAssistantText(live.generation.message.content);
      if (partialText.length > 0) {
        const runTaskId = String(live.run.taskId);
        const attempt = live.generation.attempt;
        if (
          activeGeneration !== undefined &&
          (activeGeneration.taskId !== runTaskId || activeGeneration.attempt !== attempt)
        ) {
          emitDelta({
            kind: "turn_error",
            messageId: activeGeneration.messageId,
            status: "interrupted",
            message: "Response interrupted.",
          });
          activeGeneration = undefined;
        }
        if (activeGeneration === undefined) {
          const messageId = `live-gen-${runTaskId}-a${String(attempt)}`;
          const createdAt = new Date(live.generation.message.timestamp).toISOString();
          activeGeneration = {
            taskId: runTaskId,
            attempt,
            messageId,
            emittedText: partialText,
          };
          emitDelta({
            kind: "turn_start",
            messageId,
            role: "agent",
            createdAt,
          });
          emitDelta({
            kind: "text_delta",
            messageId,
            delta: partialText,
          });
        } else if (
          partialText.length > activeGeneration.emittedText.length &&
          partialText.startsWith(activeGeneration.emittedText)
        ) {
          const delta = partialText.slice(activeGeneration.emittedText.length);
          activeGeneration.emittedText = partialText;
          emitDelta({
            kind: "text_delta",
            messageId: activeGeneration.messageId,
            delta,
          });
        }
      }
    }

    if (live?.runFailure !== undefined) {
      const failureFirst = live.runFailure.first;
      const failureAlreadyInTranscript =
        failureFirst !== undefined &&
        lastTerminalAssistantEntryId !== undefined &&
        lastTerminalAssistantEntryId >= failureFirst;
      const failureTaskId = String(live.runFailure.taskId);

      if (!failureAlreadyInTranscript && lastEmittedFailureTaskId !== failureTaskId) {
        const status =
          live.runFailure.reason === "aborted" || live.runFailure.reason === "interrupted"
            ? "interrupted"
            : "error";
        const message = formatRunFailureMessage(live.runFailure, modelsInitError);
        if (activeGeneration !== undefined) {
          emitDelta({
            kind: "turn_error",
            messageId: activeGeneration.messageId,
            status,
            message,
          });
          activeGeneration = undefined;
        } else {
          const messageId = `failure-${failureTaskId}`;
          emitDelta({
            kind: "turn_start",
            messageId,
            role: "agent",
            createdAt: lastCreatedAt ?? new Date().toISOString(),
          });
          emitDelta({
            kind: "turn_error",
            messageId,
            status,
            message,
          });
        }
        lastEmittedFailureTaskId = failureTaskId;
      }
    } else {
      lastEmittedFailureTaskId = undefined;
    }

    if (live?.run === undefined && activeGeneration !== undefined) {
      emitDelta({
        kind: "turn_error",
        messageId: activeGeneration.messageId,
        status: "interrupted",
        message: "Response interrupted.",
      });
      activeGeneration = undefined;
    }
  }

  watch.start((call) => {
    if (call.kind === "value") {
      processViewChange(call.value.entries, call.value.before, call.value.docs["pi.live"]);
    }
    return Promise.resolve();
  });

  harness.resume();

  let closePromise: Promise<void> | undefined;

  function buildSnapshotSync(): ThreadSnapshot {
    return {
      id: mainThreadId,
      agentName: agentDef.name,
      status: deriveThreadStatus(cachedLive),
      messages: mapEntriesToMessages(cachedEntries, cachedLive, modelsInitError),
    };
  }

  return {
    getSnapshot(threadId = mainThreadId): Promise<ThreadSnapshot> {
      if (threadId !== mainThreadId) {
        return Promise.reject(
          new AgentRuntimeError("unknown_thread", `Unknown thread "${threadId}".`, {
            threadId,
          }),
        );
      }
      return Promise.resolve(buildSnapshotSync());
    },

    subscribeThread(
      threadId: string,
      listener: (delta: ThreadDeltaEvent) => void,
    ): Promise<ThreadSubscription> {
      if (threadId !== mainThreadId) {
        return Promise.reject(
          new AgentRuntimeError("unknown_thread", `Unknown thread "${threadId}".`, {
            threadId,
          }),
        );
      }
      const snapshot = buildSnapshotSync();
      const currentSeq = seq;
      listeners.add(listener);
      return Promise.resolve({
        snapshot,
        seq: currentSeq,
        unsubscribe: () => {
          listeners.delete(listener);
        },
      });
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

      return {
        threadId: input.threadId,
        requestId: input.requestId,
        submissionId: String(admission.submissionId),
        deduplicated: admission.deduplicated,
      };
    },

    close(): Promise<void> {
      closePromise ??= (async () => {
        await watch.stop();
        listeners.clear();
        await harness.close(BACKGROUND_CONTEXT);
      })();
      return closePromise;
    },
  };
}
