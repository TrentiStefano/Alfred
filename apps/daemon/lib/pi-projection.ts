// Projection of Pi Durable transcript entries and live state into Alfred Thread terms.
// The snapshot builder, the watcher seeding and the live delta state machine all classify
// entries the same way through these helpers, so the three paths cannot drift.
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  UserEntry,
  type EntryRecord,
  type LiveState,
  type RunFailure,
} from "@earendil-works/pi-durable";
import { sanitizeErrorMessage } from "./sanitize-error.ts";

/** Entry kind Alfred uses when it admits an Owner message into a Pi Durable conversation. */
export const ALFRED_OWNER_ENTRY_KIND = "alfred.owner";

export type TerminalStatus = "complete" | "error" | "interrupted";

export type ProjectedEntry =
  | {
      kind: "owner";
      entryId: number;
      messageId: string;
      text: string;
      requestId?: string;
      createdAt: string;
    }
  | {
      /** A finished assistant turn: complete text, or a sanitized error/interruption message. */
      kind: "agent";
      entryId: number;
      messageId: string;
      status: TerminalStatus;
      text: string;
      createdAt: string;
    }
  | {
      /** An intermediate tool-use step with no visible text: not a terminal turn. */
      kind: "agent_tool_use";
      entryId: number;
      createdAt: string;
    };

export interface LiveGeneration {
  taskId: string;
  attempt: number;
  messageId: string;
  text: string;
  createdAt: string;
}

export interface PendingRunFailure {
  taskId: string;
  messageId: string;
  status: Exclude<TerminalStatus, "complete">;
  message: string;
}

function extractOwnerText(message: UserMessage): string {
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

function entryMessageId(entry: EntryRecord): string {
  return `entry-${String(entry.id)}`;
}

/** Classify one transcript entry, or `undefined` when it is not part of the visible Thread. */
export function projectEntry(entry: EntryRecord): ProjectedEntry | undefined {
  if (entry.kind === ALFRED_OWNER_ENTRY_KIND || UserEntry.is(entry)) {
    const ownerMsg = entry.model?.[0];
    if (ownerMsg?.role !== "user") {
      return undefined;
    }
    const requestId = extractRequestId(entry.data);
    return {
      kind: "owner",
      entryId: entry.id,
      messageId: entryMessageId(entry),
      text: extractOwnerText(ownerMsg),
      ...(requestId !== undefined ? { requestId } : {}),
      createdAt: new Date(ownerMsg.timestamp).toISOString(),
    };
  }

  if (!AssistantEntry.is(entry)) {
    return undefined;
  }
  const assistantMsg = entry.model?.[0];
  if (assistantMsg?.role !== "assistant") {
    return undefined;
  }
  const createdAt = new Date(assistantMsg.timestamp).toISOString();
  const text = extractAssistantText(assistantMsg.content);
  const hasText = text.trim().length > 0;
  const base = { kind: "agent" as const, entryId: entry.id, messageId: entryMessageId(entry) };

  if (assistantMsg.stopReason === "error") {
    const raw = hasText ? text : (assistantMsg.errorMessage ?? "Model request failed.");
    return { ...base, status: "error", text: sanitizeErrorMessage(raw), createdAt };
  }
  if (assistantMsg.stopReason === "aborted") {
    const raw = hasText ? text : (assistantMsg.errorMessage ?? "Response interrupted.");
    return {
      ...base,
      status: "interrupted",
      text: sanitizeErrorMessage(raw, "Response interrupted."),
      createdAt,
    };
  }
  if (assistantMsg.stopReason === "toolUse" && !hasText) {
    return { kind: "agent_tool_use", entryId: entry.id, createdAt };
  }
  return { ...base, status: "complete", text, createdAt };
}

/** The in-progress reply of the active run, if it has produced any text yet. */
export function projectLiveGeneration(live: LiveState | undefined): LiveGeneration | undefined {
  if (live?.run === undefined || live.generation?.message === undefined) {
    return undefined;
  }
  const text = extractAssistantText(live.generation.message.content);
  if (text.length === 0) {
    return undefined;
  }
  const taskId = String(live.run.taskId);
  const attempt = live.generation.attempt;
  return {
    taskId,
    attempt,
    messageId: `live-gen-${taskId}-a${String(attempt)}`,
    text,
    createdAt: new Date(live.generation.message.timestamp).toISOString(),
  };
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

/**
 * The run failure the Thread still has to show, or `undefined` when there is none or the
 * transcript already contains a terminal assistant entry covering it.
 */
export function projectRunFailure(
  live: LiveState | undefined,
  lastTerminalAssistantEntryId: number | undefined,
  modelsInitError: string | undefined,
): PendingRunFailure | undefined {
  const failure = live?.runFailure;
  if (failure === undefined) {
    return undefined;
  }
  const alreadyInTranscript =
    failure.first !== undefined &&
    lastTerminalAssistantEntryId !== undefined &&
    lastTerminalAssistantEntryId >= failure.first;
  if (alreadyInTranscript) {
    return undefined;
  }
  const taskId = String(failure.taskId);
  return {
    taskId,
    messageId: `failure-${taskId}`,
    status:
      failure.reason === "aborted" || failure.reason === "interrupted" ? "interrupted" : "error",
    message: formatRunFailureMessage(failure, modelsInitError),
  };
}
