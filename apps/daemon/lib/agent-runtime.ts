import {
  DEFAULT_MAIN_AGENT_NAME,
  DEFAULT_MAIN_THREAD_ID,
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
  snapshot: ThreadSnapshot;
}

export interface AgentRuntime {
  getSnapshot(threadId?: string): Promise<ThreadSnapshot>;
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

  return {
    getSnapshot(threadId = mainThreadId): Promise<ThreadSnapshot> {
      if (threadId !== mainThreadId) {
        return Promise.reject(
          new AgentRuntimeError("unknown_thread", `Unknown thread "${threadId}".`, { threadId }),
        );
      }
      return Promise.resolve(currentSnapshot());
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
          snapshot: currentSnapshot(),
        });
      }

      submissionCounter += 1;
      const submissionId = `sub-${String(submissionCounter)}`;
      submissionsByRequest.set(dedupeKey, submissionId);

      const timestamp = now().toISOString();
      messageCounter += 1;
      messages.push({
        id: `msg-${String(messageCounter)}`,
        role: "owner",
        text: input.text,
        status: "complete",
        requestId: input.requestId,
        createdAt: timestamp,
      });

      messageCounter += 1;
      messages.push({
        id: `msg-${String(messageCounter)}`,
        role: "agent",
        text: formatReply(input.text),
        status: "complete",
        createdAt: timestamp,
      });

      return Promise.resolve({
        threadId: input.threadId,
        requestId: input.requestId,
        submissionId,
        deduplicated: false,
        snapshot: currentSnapshot(),
      });
    },
  };
}
