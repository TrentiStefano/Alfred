import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context as AiContext,
} from "@earendil-works/pi-ai";
import {
  createPiDurableAgentRuntime,
  installSignalShutdown,
  startDaemonServer,
  type AgentRuntime,
} from "./index.ts";

interface ControlledStream {
  stream: AssistantMessageEventStream;
  text: string;
}

type ControlCommand =
  | { cmd: "push_chunk"; text: string }
  | { cmd: "finish"; text?: string }
  | { cmd: "error"; message: string };

const PROVIDER_ID = "e2e-provider";
const MODEL_ID = "e2e-model";

function emitEvent(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function makeAssistantMessage(
  text: string,
  stopReason: AssistantMessage["stopReason"],
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: text.length > 0 ? [{ type: "text", text }] : [],
    api: "faux",
    provider: PROVIDER_ID,
    model: MODEL_ID,
    usage: {
      input: 1,
      output: Math.max(1, text.length),
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1 + Math.max(1, text.length),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

function extractLastOwnerText(context: AiContext): string {
  for (let i = context.messages.length - 1; i >= 0; i -= 1) {
    const msg = context.messages[i];
    if (msg?.role === "user") {
      if (typeof msg.content === "string") {
        return msg.content;
      }
      return msg.content
        .filter(
          (block): block is Extract<(typeof msg.content)[number], { type: "text" }> =>
            block.type === "text",
        )
        .map((block) => block.text)
        .join("");
    }
  }
  return "";
}

function parseControlCommand(line: string): ControlCommand | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(trimmed);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (record.cmd === "push_chunk" && typeof record.text === "string") {
    return { cmd: "push_chunk", text: record.text };
  }
  if (record.cmd === "finish") {
    return typeof record.text === "string"
      ? { cmd: "finish", text: record.text }
      : { cmd: "finish" };
  }
  if (record.cmd === "error" && typeof record.message === "string") {
    return { cmd: "error", message: record.message };
  }
  return undefined;
}

const sqlitePath = process.env.ALFRED_E2E_SQLITE_PATH;
if (sqlitePath === undefined || sqlitePath.trim().length === 0) {
  throw new Error("ALFRED_E2E_SQLITE_PATH is required.");
}

const host = process.env.ALFRED_DAEMON_HOST ?? "127.0.0.1";
const port = Number(process.env.ALFRED_DAEMON_PORT ?? "0");
const mode = process.env.ALFRED_E2E_MODE === "controlled" ? "controlled" : "auto";
const autoReply = process.env.ALFRED_E2E_AUTO_REPLY ?? "Auto reply from E2E daemon.";
const retryEnabled = process.env.ALFRED_E2E_RETRY_ENABLED !== "false";
const retryBaseDelayMs = Number(process.env.ALFRED_E2E_RETRY_BASE_MS ?? "50");
const partialIntervalMs = Number(process.env.ALFRED_E2E_PARTIAL_INTERVAL_MS ?? "0");
const persistWithinMs = Number(process.env.ALFRED_E2E_PERSIST_WITHIN_MS ?? "0");

let callCount = 0;
let activeStream: ControlledStream | undefined;

function startStream(_model: unknown, context: AiContext): AssistantMessageEventStream {
  callCount += 1;
  const currentCall = callCount;
  const prompt = extractLastOwnerText(context);
  const stream = createAssistantMessageEventStream();

  if (mode === "auto") {
    emitEvent({ event: "stream_started", callCount: currentCall, prompt });
    queueMicrotask(() => {
      const reply = autoReply.replaceAll("{prompt}", prompt);
      stream.push({ type: "start", partial: makeAssistantMessage("", "pending") });
      stream.push({
        type: "text_start",
        contentIndex: 0,
        partial: makeAssistantMessage("", "pending"),
      });
      stream.push({
        type: "text_delta",
        contentIndex: 0,
        delta: reply,
        partial: makeAssistantMessage(reply, "pending"),
      });
      const finalMsg = makeAssistantMessage(reply, "stop");
      stream.push({ type: "text_end", contentIndex: 0, content: reply, partial: finalMsg });
      stream.push({ type: "done", reason: "stop", message: finalMsg });
    });
    return stream;
  }

  activeStream = { stream, text: "" };
  stream.push({ type: "start", partial: makeAssistantMessage("", "pending") });
  emitEvent({ event: "stream_started", callCount: currentCall, prompt });
  return stream;
}

if (mode === "controlled") {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const command = parseControlCommand(line);
    if (command === undefined || activeStream === undefined) {
      return;
    }
    if (command.cmd === "push_chunk") {
      const hadText = activeStream.text.length > 0;
      activeStream.text += command.text;
      if (!hadText) {
        activeStream.stream.push({
          type: "text_start",
          contentIndex: 0,
          partial: makeAssistantMessage("", "pending"),
        });
      }
      activeStream.stream.push({
        type: "text_delta",
        contentIndex: 0,
        delta: command.text,
        partial: makeAssistantMessage(activeStream.text, "pending"),
      });
      return;
    }
    if (command.cmd === "finish") {
      const finalText = command.text ?? activeStream.text;
      if (activeStream.text.length === 0 && finalText.length > 0) {
        activeStream.stream.push({
          type: "text_start",
          contentIndex: 0,
          partial: makeAssistantMessage("", "pending"),
        });
        activeStream.stream.push({
          type: "text_delta",
          contentIndex: 0,
          delta: finalText,
          partial: makeAssistantMessage(finalText, "pending"),
        });
      }
      const finalMsg = makeAssistantMessage(finalText, "stop");
      activeStream.stream.push({
        type: "text_end",
        contentIndex: 0,
        content: finalText,
        partial: finalMsg,
      });
      activeStream.stream.push({ type: "done", reason: "stop", message: finalMsg });
      activeStream = undefined;
      return;
    }
    const errMsg = makeAssistantMessage("", "error", command.message);
    activeStream.stream.push({ type: "error", reason: "error", error: errMsg });
    activeStream = undefined;
  });
}

const provider = createProvider({
  id: PROVIDER_ID,
  auth: {
    apiKey: {
      name: "E2E API Key",
      resolve: () => Promise.resolve({ auth: { apiKey: "e2e-test-key" } }),
    },
  },
  models: [
    {
      id: MODEL_ID,
      name: "E2E Model",
      api: "faux",
      provider: PROVIDER_ID,
      baseUrl: "http://127.0.0.1:0",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16_384,
      maxTokens: 1024,
    },
  ],
  api: {
    stream: startStream,
    streamSimple: startStream,
  },
});

const models = createModels();
models.setProvider(provider);

const exampleAgentPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "agents",
  "main.example.md",
);

const innerRuntime = await createPiDurableAgentRuntime({
  sqlitePath,
  agentDefinitionPath: exampleAgentPath,
  models,
  model: { provider: PROVIDER_ID, modelId: MODEL_ID },
  retry: {
    enabled: retryEnabled,
    maxRetries: 3,
    baseDelayMs: retryBaseDelayMs,
    maxAgentDelayMs: retryBaseDelayMs,
  },
  progress: {
    partialIntervalMs,
    persistWithinMs,
  },
});

const agentRuntime: AgentRuntime = {
  getSnapshot: (threadId) => innerRuntime.getSnapshot(threadId),
  subscribeThread: async (threadId, listener) => {
    const subscription = await innerRuntime.subscribeThread(threadId, listener);
    emitEvent({ event: "client_subscribed", threadId, seq: subscription.seq });
    return subscription;
  },
  submit: (input) => innerRuntime.submit(input),
  ...(innerRuntime.close !== undefined
    ? { close: () => innerRuntime.close?.() ?? Promise.resolve() }
    : {}),
};

const server = await startDaemonServer({ host, port, agentRuntime });
emitEvent({ event: "listening", host, port: server.port });

installSignalShutdown({
  close: () => server.close(),
  onSignal: (signal) => {
    emitEvent({ event: "shutting_down", signal });
  },
});
