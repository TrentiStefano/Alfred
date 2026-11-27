import { z } from "zod";
import { PROTOCOL_VERSION } from "./version.ts";

export const DEFAULT_MAIN_THREAD_ID = "main";
export const DEFAULT_MAIN_AGENT_NAME = "Alfred";

export const ThreadMessageRoleSchema = z.enum(["owner", "agent"]);
export type ThreadMessageRole = z.infer<typeof ThreadMessageRoleSchema>;

export const ThreadMessageStatusSchema = z.enum(["complete", "streaming", "error", "interrupted"]);
export type ThreadMessageStatus = z.infer<typeof ThreadMessageStatusSchema>;

export const ThreadStatusSchema = z.enum(["idle", "streaming", "error"]);
export type ThreadStatus = z.infer<typeof ThreadStatusSchema>;

export const ProtocolErrorCodeSchema = z.enum([
  "handshake_required",
  "unsupported_protocol_version",
  "invalid_message",
  "unknown_thread",
  "invalid_state",
  "runtime_error",
]);
export type ProtocolErrorCode = z.infer<typeof ProtocolErrorCodeSchema>;

export const HelloClientInfoSchema = z.strictObject({
  name: z.string().min(1),
  version: z.string().min(1).exactOptional(),
  platform: z.string().min(1).exactOptional(),
});
export type HelloClientInfo = z.infer<typeof HelloClientInfoSchema>;

export const HelloMessageSchema = z.strictObject({
  type: z.literal("hello"),
  protocolVersion: z.number().int().positive(),
  client: HelloClientInfoSchema.exactOptional(),
});
export type HelloMessage = z.infer<typeof HelloMessageSchema>;

export const SubmitMessageSchema = z.strictObject({
  type: z.literal("submit"),
  threadId: z.string().min(1),
  requestId: z.string().min(1),
  text: z
    .string()
    .min(1)
    .refine((value) => value.trim().length > 0, "text must not be blank"),
});
export type SubmitMessage = z.infer<typeof SubmitMessageSchema>;

export const ClientMessageSchema = z.discriminatedUnion("type", [
  HelloMessageSchema,
  SubmitMessageSchema,
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export const ThreadMessageSchema = z.strictObject({
  id: z.string().min(1),
  role: ThreadMessageRoleSchema,
  text: z.string(),
  status: ThreadMessageStatusSchema,
  requestId: z.string().min(1).exactOptional(),
  createdAt: z.iso.datetime(),
});
export type ThreadMessage = z.infer<typeof ThreadMessageSchema>;

export const ThreadSnapshotSchema = z.strictObject({
  id: z.string().min(1),
  agentName: z.string().min(1),
  status: ThreadStatusSchema,
  messages: z.array(ThreadMessageSchema),
});
export type ThreadSnapshot = z.infer<typeof ThreadSnapshotSchema>;

export const SnapshotMessageSchema = z.strictObject({
  type: z.literal("snapshot"),
  protocolVersion: z.number().int().positive(),
  seq: z.number().int().nonnegative(),
  thread: ThreadSnapshotSchema,
});
export type SnapshotMessage = z.infer<typeof SnapshotMessageSchema>;

export const AckMessageSchema = z.strictObject({
  type: z.literal("ack"),
  threadId: z.string().min(1),
  requestId: z.string().min(1),
  submissionId: z.string().min(1),
  deduplicated: z.boolean().exactOptional(),
});
export type AckMessage = z.infer<typeof AckMessageSchema>;

export const DeltaTurnStartEventSchema = z.strictObject({
  kind: z.literal("turn_start"),
  messageId: z.string().min(1),
  role: ThreadMessageRoleSchema,
  text: z.string().exactOptional(),
  requestId: z.string().min(1).exactOptional(),
  createdAt: z.iso.datetime(),
});
export type DeltaTurnStartEvent = z.infer<typeof DeltaTurnStartEventSchema>;

export const DeltaTextDeltaEventSchema = z.strictObject({
  kind: z.literal("text_delta"),
  messageId: z.string().min(1),
  delta: z.string().min(1),
});
export type DeltaTextDeltaEvent = z.infer<typeof DeltaTextDeltaEventSchema>;

export const DeltaTurnFinishEventSchema = z.strictObject({
  kind: z.literal("turn_finish"),
  messageId: z.string().min(1),
  status: z.literal("complete"),
});
export type DeltaTurnFinishEvent = z.infer<typeof DeltaTurnFinishEventSchema>;

export const DeltaTurnErrorEventSchema = z.strictObject({
  kind: z.literal("turn_error"),
  messageId: z.string().min(1),
  status: z.enum(["error", "interrupted"]),
  message: z.string().min(1),
});
export type DeltaTurnErrorEvent = z.infer<typeof DeltaTurnErrorEventSchema>;

export const DeltaEventSchema = z.discriminatedUnion("kind", [
  DeltaTurnStartEventSchema,
  DeltaTextDeltaEventSchema,
  DeltaTurnFinishEventSchema,
  DeltaTurnErrorEventSchema,
]);
export type DeltaEvent = z.infer<typeof DeltaEventSchema>;

export const DeltaMessageSchema = z.strictObject({
  type: z.literal("delta"),
  protocolVersion: z.number().int().positive(),
  threadId: z.string().min(1),
  seq: z.number().int().positive(),
  event: DeltaEventSchema,
});
export type DeltaMessage = z.infer<typeof DeltaMessageSchema>;

export const ErrorMessageSchema = z.strictObject({
  type: z.literal("error"),
  code: ProtocolErrorCodeSchema,
  message: z.string().min(1),
  protocolVersion: z.number().int().positive().exactOptional(),
  expectedProtocolVersion: z.number().int().positive().exactOptional(),
  threadId: z.string().min(1).exactOptional(),
  requestId: z.string().min(1).exactOptional(),
});
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;

export const DaemonMessageSchema = z.discriminatedUnion("type", [
  SnapshotMessageSchema,
  DeltaMessageSchema,
  AckMessageSchema,
  ErrorMessageSchema,
]);
export type DaemonMessage = z.infer<typeof DaemonMessageSchema>;

/** Create and validate a `hello` handshake frame. */
export function createHelloMessage(
  options: { protocolVersion?: number; client?: HelloClientInfo } = {},
): HelloMessage {
  return HelloMessageSchema.parse({
    type: "hello",
    protocolVersion: options.protocolVersion ?? PROTOCOL_VERSION,
    ...(options.client !== undefined ? { client: options.client } : {}),
  });
}

/** Create and validate a `submit` prompt frame. */
export function createSubmitMessage(input: {
  threadId: string;
  requestId: string;
  text: string;
}): SubmitMessage {
  return SubmitMessageSchema.parse({
    type: "submit",
    threadId: input.threadId,
    requestId: input.requestId,
    text: input.text,
  });
}

/** Create and validate a `snapshot` frame. */
export function createSnapshotMessage(input: {
  protocolVersion?: number;
  seq: number;
  thread: ThreadSnapshot;
}): SnapshotMessage {
  return SnapshotMessageSchema.parse({
    type: "snapshot",
    protocolVersion: input.protocolVersion ?? PROTOCOL_VERSION,
    seq: input.seq,
    thread: input.thread,
  });
}

/** Create and validate an `ack` frame. */
export function createAckMessage(input: {
  threadId: string;
  requestId: string;
  submissionId: string;
  deduplicated?: boolean;
}): AckMessage {
  return AckMessageSchema.parse({
    type: "ack",
    threadId: input.threadId,
    requestId: input.requestId,
    submissionId: input.submissionId,
    ...(input.deduplicated !== undefined ? { deduplicated: input.deduplicated } : {}),
  });
}

/** Create and validate a sequenced `delta` frame. */
export function createDeltaMessage(input: {
  protocolVersion?: number;
  threadId: string;
  seq: number;
  event: DeltaEvent;
}): DeltaMessage {
  return DeltaMessageSchema.parse({
    type: "delta",
    protocolVersion: input.protocolVersion ?? PROTOCOL_VERSION,
    threadId: input.threadId,
    seq: input.seq,
    event: input.event,
  });
}

/** Create and validate an `error` frame. */
export function createErrorMessage(input: {
  code: ProtocolErrorCode;
  message: string;
  protocolVersion?: number;
  expectedProtocolVersion?: number;
  threadId?: string;
  requestId?: string;
}): ErrorMessage {
  return ErrorMessageSchema.parse({
    type: "error",
    code: input.code,
    message: input.message,
    ...(input.protocolVersion !== undefined ? { protocolVersion: input.protocolVersion } : {}),
    ...(input.expectedProtocolVersion !== undefined
      ? { expectedProtocolVersion: input.expectedProtocolVersion }
      : {}),
    ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
  });
}

/** Parse and validate an untrusted Client -> Daemon WebSocket payload. */
export function parseClientMessage(input: unknown): ClientMessage {
  return ClientMessageSchema.parse(input);
}

/** Parse and validate an untrusted Daemon -> Client WebSocket payload. */
export function parseDaemonMessage(input: unknown): DaemonMessage {
  return DaemonMessageSchema.parse(input);
}
