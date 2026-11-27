import {
  DEFAULT_MAIN_AGENT_NAME,
  DEFAULT_MAIN_THREAD_ID,
  type DeltaEvent,
  type ProtocolErrorCode,
  type ThreadMessage,
  type ThreadSnapshot,
} from "@alfred/protocol";

export interface SubmitInput {
  threadId: string;
  requestId: string;
  text: string;
}

export interface SubmitResult {
  threadId: string;
  requestId: string;
  submissionId: string;
  deduplicated: boolean;
}

export interface ThreadDeltaEvent {
  threadId: string;
  seq: number;
  event: DeltaEvent;
}

export interface ThreadSubscription {
  snapshot: ThreadSnapshot;
  seq: number;
  unsubscribe(): void;
}

export interface AgentRuntime {
  getSnapshot(threadId?: string): Promise<ThreadSnapshot>;
  subscribeThread(
    threadId: string,
    listener: (delta: ThreadDeltaEvent) => void,
  ): Promise<ThreadSubscription>;
  submit(input: SubmitInput): Promise<SubmitResult>;
  close?(): Promise<void>;
}

/** Structured runtime error mapped directly onto protocol `error` frames. */
export class AgentRuntimeError extends Error {
  readonly code: ProtocolErrorCode;
  readonly threadId: string | undefined;
  readonly requestId: string | undefined;

  constructor(
    code: ProtocolErrorCode,
    message: string,
    options: { threadId?: string; requestId?: string } = {},
  ) {
    super(message);
    this.name = "AgentRuntimeError";
    this.code = code;
    this.threadId = options.threadId;
    this.requestId = options.requestId;
  }
}

export interface StubAgentRuntimeOptions {
  threadId?: string;
  agentName?: string;
  replyText?: (prompt: string) => string;
  now?: () => Date;
}

function cloneSnapshot(snapshot: ThreadSnapshot): ThreadSnapshot {
  return {
    id: snapshot.id,
    agentName: snapshot.agentName,
    status: snapshot.status,
    messages: snapshot.messages.map((message) => ({ ...message })),
  };
}

/** In-memory stub `AgentRuntime` for Slice 1 protocol and client development. */
export function createStubAgentRuntime(options: StubAgentRuntimeOptions = {}): AgentRuntime {
  const mainThreadId = options.threadId ?? DEFAULT_MAIN_THREAD_ID;
  const agentName = options.agentName ?? DEFAULT_MAIN_AGENT_NAME;
  const formatReply =
    options.replyText ?? ((prompt: string) => `Stub ${agentName} received: ${prompt}`);
  const now = options.now ?? (() => new Date());

  const messages: ThreadMessage[] = [];
  const submissionsByRequest = new Map<string, string>();
  const listeners = new Set<(delta: ThreadDeltaEvent) => void>();
  let seq = 0;
  let submissionCounter = 0;
  let messageCounter = 0;

  function currentSnapshot(): ThreadSnapshot {
    return cloneSnapshot({
      id: mainThreadId,
      agentName,
      status: "idle",
      messages,
    });
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

  return {
    getSnapshot(threadId = mainThreadId): Promise<ThreadSnapshot> {
      if (threadId !== mainThreadId) {
        return Promise.reject(
          new AgentRuntimeError("unknown_thread", `Unknown thread "${threadId}".`, { threadId }),
        );
      }
      return Promise.resolve(currentSnapshot());
    },

    subscribeThread(
      threadId: string,
      listener: (delta: ThreadDeltaEvent) => void,
    ): Promise<ThreadSubscription> {
      if (threadId !== mainThreadId) {
        return Promise.reject(
          new AgentRuntimeError("unknown_thread", `Unknown thread "${threadId}".`, { threadId }),
        );
      }
      listeners.add(listener);
      return Promise.resolve({
        snapshot: currentSnapshot(),
        seq,
        unsubscribe: () => {
          listeners.delete(listener);
        },
      });
    },

    submit(input: SubmitInput): Promise<SubmitResult> {
      if (input.threadId !== mainThreadId) {
        return Promise.reject(
          new AgentRuntimeError("unknown_thread", `Unknown thread "${input.threadId}".`, {
            threadId: input.threadId,
            requestId: input.requestId,
          }),
        );
      }

      const dedupeKey = `${input.threadId}:${input.requestId}`;
      const existingSubmissionId = submissionsByRequest.get(dedupeKey);
      if (existingSubmissionId !== undefined) {
        return Promise.resolve({
          threadId: input.threadId,
          requestId: input.requestId,
          submissionId: existingSubmissionId,
          deduplicated: true,
        });
      }

      submissionCounter += 1;
      const submissionId = `sub-${String(submissionCounter)}`;
      submissionsByRequest.set(dedupeKey, submissionId);

      const timestamp = now().toISOString();
      messageCounter += 1;
      const ownerMessageId = `msg-${String(messageCounter)}`;
      messages.push({
        id: ownerMessageId,
        role: "owner",
        text: input.text,
        status: "complete",
        requestId: input.requestId,
        createdAt: timestamp,
      });

      messageCounter += 1;
      const agentMessageId = `msg-${String(messageCounter)}`;
      const reply = formatReply(input.text);
      messages.push({
        id: agentMessageId,
        role: "agent",
        text: reply,
        status: "complete",
        createdAt: timestamp,
      });

      queueMicrotask(() => {
        emitDelta({
          kind: "turn_start",
          messageId: ownerMessageId,
          role: "owner",
          text: input.text,
          requestId: input.requestId,
          createdAt: timestamp,
        });
        emitDelta({
          kind: "turn_finish",
          messageId: ownerMessageId,
          status: "complete",
        });
        emitDelta({
          kind: "turn_start",
          messageId: agentMessageId,
          role: "agent",
          createdAt: timestamp,
        });
        if (reply.length > 0) {
          emitDelta({
            kind: "text_delta",
            messageId: agentMessageId,
            delta: reply,
          });
        }
        emitDelta({
          kind: "turn_finish",
          messageId: agentMessageId,
          status: "complete",
        });
      });

      return Promise.resolve({
        threadId: input.threadId,
        requestId: input.requestId,
        submissionId,
        deduplicated: false,
      });
    },
  };
}
