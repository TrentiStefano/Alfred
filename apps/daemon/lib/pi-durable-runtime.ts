import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type Models } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  Harness,
  createRegistry,
  type AgentChange,
  type Conversation,
  type Cursor,
  type EntryRecord,
  type HarnessSettings,
  type LiveState,
  type ModelRef,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  DEFAULT_MAIN_THREAD_ID,
  type DeltaEvent,
  type ThreadMessage,
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
import {
  ALFRED_OWNER_ENTRY_KIND,
  projectEntry,
  projectLiveGeneration,
  projectRunFailure,
} from "./pi-projection.ts";
import { sanitizeErrorMessage } from "./sanitize-error.ts";

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

function mapEntriesToMessages(
  entries: readonly EntryRecord[],
  live: LiveState | undefined,
  modelsInitError: string | undefined,
): ThreadMessage[] {
  const messages: ThreadMessage[] = [];
  let lastTerminalAssistantEntryId: number | undefined;
  let lastCreatedAt: string | undefined;

  for (const entry of entries) {
    const projected = projectEntry(entry);
    if (projected === undefined) {
      continue;
    }
    lastCreatedAt = projected.createdAt;
    if (projected.kind === "owner") {
      messages.push({
        id: projected.messageId,
        role: "owner",
        text: projected.text,
        status: "complete",
        ...(projected.requestId !== undefined ? { requestId: projected.requestId } : {}),
        createdAt: projected.createdAt,
      });
    } else if (projected.kind === "agent") {
      lastTerminalAssistantEntryId = projected.entryId;
      messages.push({
        id: projected.messageId,
        role: "agent",
        text: projected.text,
        status: projected.status,
        createdAt: projected.createdAt,
      });
    }
  }

  const generation = projectLiveGeneration(live);
  if (generation !== undefined) {
    messages.push({
      id: generation.messageId,
      role: "agent",
      text: generation.text,
      status: "streaming",
      createdAt: generation.createdAt,
    });
  }

  const failure = projectRunFailure(live, lastTerminalAssistantEntryId, modelsInitError);
  if (failure !== undefined) {
    messages.push({
      id: failure.messageId,
      role: "agent",
      text: failure.message,
      status: failure.status,
      createdAt: lastCreatedAt ?? new Date().toISOString(),
    });
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
    const projected = projectEntry(entry);
    if (projected === undefined) {
      continue;
    }
    lastCreatedAt = projected.createdAt;
    if (projected.kind === "agent") {
      lastTerminalAssistantEntryId = projected.entryId;
    }
  }
  const seededGeneration = projectLiveGeneration(cachedLive);
  if (seededGeneration !== undefined) {
    activeGeneration = {
      taskId: seededGeneration.taskId,
      attempt: seededGeneration.attempt,
      messageId: seededGeneration.messageId,
      emittedText: seededGeneration.text,
    };
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

      const projected = projectEntry(entry);
      if (projected === undefined) {
        continue;
      }
      lastCreatedAt = projected.createdAt;

      if (projected.kind === "owner") {
        emitDelta({
          kind: "turn_start",
          messageId: projected.messageId,
          role: "owner",
          text: projected.text,
          ...(projected.requestId !== undefined ? { requestId: projected.requestId } : {}),
          createdAt: projected.createdAt,
        });
        emitDelta({
          kind: "turn_finish",
          messageId: projected.messageId,
          status: "complete",
        });
        continue;
      }

      if (projected.kind === "agent_tool_use") {
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

      const messageId = activeGeneration?.messageId ?? projected.messageId;
      if (activeGeneration === undefined) {
        emitDelta({
          kind: "turn_start",
          messageId,
          role: "agent",
          createdAt: projected.createdAt,
        });
      }

      if (projected.status === "complete") {
        const alreadyEmitted = activeGeneration?.emittedText ?? "";
        const remaining = projected.text.startsWith(alreadyEmitted)
          ? projected.text.slice(alreadyEmitted.length)
          : projected.text;
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
      } else {
        emitDelta({
          kind: "turn_error",
          messageId,
          status: projected.status,
          message: projected.text,
        });
      }

      lastTerminalAssistantEntryId = projected.entryId;
      activeGeneration = undefined;
    }

    const generation = projectLiveGeneration(live);
    if (generation !== undefined) {
      if (
        activeGeneration !== undefined &&
        (activeGeneration.taskId !== generation.taskId ||
          activeGeneration.attempt !== generation.attempt)
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
        activeGeneration = {
          taskId: generation.taskId,
          attempt: generation.attempt,
          messageId: generation.messageId,
          emittedText: generation.text,
        };
        emitDelta({
          kind: "turn_start",
          messageId: generation.messageId,
          role: "agent",
          createdAt: generation.createdAt,
        });
        emitDelta({
          kind: "text_delta",
          messageId: generation.messageId,
          delta: generation.text,
        });
      } else if (
        generation.text.length > activeGeneration.emittedText.length &&
        generation.text.startsWith(activeGeneration.emittedText)
      ) {
        const delta = generation.text.slice(activeGeneration.emittedText.length);
        activeGeneration.emittedText = generation.text;
        emitDelta({
          kind: "text_delta",
          messageId: activeGeneration.messageId,
          delta,
        });
      }
    }

    if (live?.runFailure !== undefined) {
      const failure = projectRunFailure(live, lastTerminalAssistantEntryId, modelsInitError);
      if (failure !== undefined && lastEmittedFailureTaskId !== failure.taskId) {
        if (activeGeneration !== undefined) {
          emitDelta({
            kind: "turn_error",
            messageId: activeGeneration.messageId,
            status: failure.status,
            message: failure.message,
          });
          activeGeneration = undefined;
        } else {
          emitDelta({
            kind: "turn_start",
            messageId: failure.messageId,
            role: "agent",
            createdAt: lastCreatedAt ?? new Date().toISOString(),
          });
          emitDelta({
            kind: "turn_error",
            messageId: failure.messageId,
            status: failure.status,
            message: failure.message,
          });
        }
        lastEmittedFailureTaskId = failure.taskId;
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
            kind: ALFRED_OWNER_ENTRY_KIND,
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
