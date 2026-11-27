import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getSystemMessageText,
  type AssistantMessage,
  type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import {
  DEFAULT_MAIN_AGENT_NAME,
  DEFAULT_MAIN_THREAD_ID,
  PROTOCOL_VERSION,
  createHelloMessage,
  createSubmitMessage,
  parseDaemonMessage,
  type DaemonMessage,
  type DeltaMessage,
} from "@alfred/protocol";
import { SEARXNG_SEARCH_CONTRACT } from "../index.ts";
import {
  createPiDurableAgentRuntime,
  startDaemonServer,
  type AgentRuntime,
  type DaemonServer,
} from "../index.ts";

const execFileAsync = promisify(execFile);

interface WsTestClient {
  nextMessage(): Promise<DaemonMessage>;
  sendJson(payload: unknown): void;
  close(): Promise<void>;
}

async function connectWs(port: number): Promise<WsTestClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
  const inbox: DaemonMessage[] = [];
  const waiters: ((message: DaemonMessage) => void)[] = [];

  ws.on("message", (data) => {
    const text =
      typeof data === "string"
        ? data
        : Buffer.isBuffer(data)
          ? data.toString("utf8")
          : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]).toString("utf8");
    const parsed = parseDaemonMessage(JSON.parse(text));
    const waiter = waiters.shift();
    if (waiter !== undefined) {
      waiter(parsed);
    } else {
      inbox.push(parsed);
    }
  });

  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => {
      resolve();
    });
    ws.once("error", (err) => {
      reject(err);
    });
  });

  return {
    nextMessage: () => {
      const queued = inbox.shift();
      if (queued !== undefined) {
        return Promise.resolve(queued);
      }
      return new Promise<DaemonMessage>((resolve) => {
        waiters.push(resolve);
      });
    },
    sendJson: (payload: unknown) => {
      ws.send(JSON.stringify(payload));
    },
    close: () => {
      if (ws.readyState === WebSocket.CLOSED) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        ws.once("close", () => {
          resolve();
        });
        ws.close();
      });
    },
  };
}

async function collectTurnDeltas(
  client: WsTestClient,
  targetRole: "owner" | "agent" = "agent",
): Promise<DeltaMessage[]> {
  const deltas: DeltaMessage[] = [];
  const startedIds = new Set<string>();
  for (;;) {
    const msg = await client.nextMessage();
    expect(msg.type).toBe("delta");
    if (msg.type !== "delta") {
      throw new Error(`Expected delta frame, got ${msg.type}`);
    }
    deltas.push(msg);
    if (msg.event.kind === "turn_start" && msg.event.role === targetRole) {
      startedIds.add(msg.event.messageId);
    }
    if (
      (msg.event.kind === "turn_finish" || msg.event.kind === "turn_error") &&
      startedIds.has(msg.event.messageId)
    ) {
      return deltas;
    }
  }
}

describe("Pi Durable AgentRuntime over WebSocket", () => {
  const tempDirs: string[] = [];
  let server: DaemonServer | undefined;
  let runtime: AgentRuntime | undefined;

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "alfred-daemon-test-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
      runtime = undefined;
    } else if (runtime !== undefined) {
      await runtime.close?.();
      runtime = undefined;
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("declares SearXNG web search as a read-risk Tool", () => {
    expect(SEARXNG_SEARCH_CONTRACT).toEqual({ tool: "searxng_web_search", risk: "read" });
  });

  it("persists Thread messages in SQLite across daemon restarts", async () => {
    const dir = makeTempDir();
    const sqlitePath = join(dir, "main.sqlite");

    const faux1 = fauxProvider({ tokensPerSecond: 10_000 });
    faux1.setResponses([fauxAssistantMessage("Good morning, Owner.")]);
    const models1 = createModels();
    models1.setProvider(faux1.provider);

    runtime = await createPiDurableAgentRuntime({
      sqlitePath,
      models: models1,
      model: { provider: faux1.provider.id, modelId: faux1.getModel().id },
      retry: { enabled: false },
    });
    server = await startDaemonServer({ host: "127.0.0.1", port: 0, agentRuntime: runtime });

    const client1 = await connectWs(server.port);
    client1.sendJson(createHelloMessage());
    const initial = await client1.nextMessage();
    expect(initial).toEqual({
      type: "snapshot",
      protocolVersion: PROTOCOL_VERSION,
      seq: 0,
      thread: {
        id: DEFAULT_MAIN_THREAD_ID,
        agentName: DEFAULT_MAIN_AGENT_NAME,
        status: "idle",
        messages: [],
      },
    });

    client1.sendJson(
      createSubmitMessage({
        threadId: DEFAULT_MAIN_THREAD_ID,
        requestId: "req-persist-1",
        text: "Hello Alfred",
      }),
    );

    const ack = await client1.nextMessage();
    expect(ack.type).toBe("ack");
    if (ack.type === "ack") {
      expect(ack.requestId).toBe("req-persist-1");
      expect(ack.deduplicated).toBe(false);
    }

    const deltas = await collectTurnDeltas(client1);
    expect(deltas.map((d) => d.seq)).toEqual(deltas.map((_, idx) => idx + 1));
    const agentText = deltas
      .filter((d) => d.event.kind === "text_delta")
      .map((d) => (d.event.kind === "text_delta" ? d.event.delta : ""))
      .join("");
    expect(agentText).toBe("Good morning, Owner.");

    const updated = await runtime.getSnapshot();
    expect(updated.status).toBe("idle");
    expect(updated.messages).toHaveLength(2);
    expect(updated.messages[0]?.role).toBe("owner");
    expect(updated.messages[0]?.text).toBe("Hello Alfred");
    expect(updated.messages[0]?.requestId).toBe("req-persist-1");
    expect(updated.messages[1]?.role).toBe("agent");
    expect(updated.messages[1]?.text).toBe("Good morning, Owner.");
    expect(updated.messages[1]?.status).toBe("complete");

    await client1.close();
    await server.close();
    server = undefined;
    runtime = undefined;

    // Reopen on the same SQLite file with a fresh runtime & daemon.
    const faux2 = fauxProvider({ tokensPerSecond: 10_000 });
    const models2 = createModels();
    models2.setProvider(faux2.provider);

    runtime = await createPiDurableAgentRuntime({
      sqlitePath,
      models: models2,
      model: { provider: faux2.provider.id, modelId: faux2.getModel().id },
      retry: { enabled: false },
    });
    server = await startDaemonServer({ host: "127.0.0.1", port: 0, agentRuntime: runtime });

    const client2 = await connectWs(server.port);
    client2.sendJson(createHelloMessage());
    const restored = await client2.nextMessage();
    expect(restored.type).toBe("snapshot");
    if (restored.type === "snapshot") {
      expect(restored.seq).toBe(0);
      expect(restored.thread.agentName).toBe(DEFAULT_MAIN_AGENT_NAME);
      expect(restored.thread.status).toBe("idle");
      expect(restored.thread.messages).toHaveLength(2);
      expect(restored.thread.messages[0]?.role).toBe("owner");
      expect(restored.thread.messages[0]?.text).toBe("Hello Alfred");
      expect(restored.thread.messages[0]?.requestId).toBe("req-persist-1");
      expect(restored.thread.messages[1]?.role).toBe("agent");
      expect(restored.thread.messages[1]?.text).toBe("Good morning, Owner.");
    }

    await client2.close();
  });

  it("uses the configured SearXNG search Tool in the existing Thread", async () => {
    const dir = makeTempDir();
    const faux = fauxProvider({ tokensPerSecond: 10_000 });
    const expectedSearch = "Synthetic result for Alfred";
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("searxng_web_search", { query: "Alfred" }, { id: "search-1" }),
        { stopReason: "toolUse" },
      ),
      (context) => {
        const result = context.messages.find(
          (message) => message.role === "toolResult" && message.toolCallId === "search-1",
        );
        const firstContent = result?.role === "toolResult" ? result.content[0] : undefined;
        const text = firstContent?.type === "text" ? firstContent.text : undefined;
        return fauxAssistantMessage(`Search says: ${text ?? "missing result"}`);
      },
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    let searchCount = 0;

    runtime = await createPiDurableAgentRuntime({
      sqlitePath: join(dir, "search.sqlite"),
      models,
      model: { provider: faux.provider.id, modelId: faux.getModel().id },
      retry: { enabled: false },
      searxng: {
        enabled: true,
        search: (query) => {
          searchCount += 1;
          expect(query).toBe("Alfred");
          return Promise.resolve(expectedSearch);
        },
      },
    });
    server = await startDaemonServer({ host: "127.0.0.1", port: 0, agentRuntime: runtime });

    const client = await connectWs(server.port);
    client.sendJson(createHelloMessage());
    await client.nextMessage();
    client.sendJson(
      createSubmitMessage({
        threadId: DEFAULT_MAIN_THREAD_ID,
        requestId: "req-search-1",
        text: "Search for Alfred",
      }),
    );
    await client.nextMessage();
    const deltas = await collectTurnDeltas(client);
    const reply = deltas
      .filter((delta) => delta.event.kind === "text_delta")
      .map((delta) => (delta.event.kind === "text_delta" ? delta.event.delta : ""))
      .join("");

    expect(searchCount).toBe(1);
    expect(reply).toBe(`Search says: ${expectedSearch}`);
    expect(faux.state.callCount).toBe(2);
    await client.close();
  });

  it("reports an interrupted search and accepts a later search in the same Thread", async () => {
    const dir = makeTempDir();
    const faux = fauxProvider({ tokensPerSecond: 10_000 });
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("searxng_web_search", { query: "first attempt" }, { id: "failed-search" }),
        { stopReason: "toolUse" },
      ),
      (context) => {
        const result = context.messages.find(
          (message) => message.role === "toolResult" && message.toolCallId === "failed-search",
        );
        const content = result?.role === "toolResult" ? result.content[0] : undefined;
        return fauxAssistantMessage(
          content?.type === "text" && content.text.includes("unavailable")
            ? "The search Environment is unavailable. I can still help with other questions."
            : "The search did not report its failure.",
        );
      },
      fauxAssistantMessage("Ordinary conversation is still available."),
      fauxAssistantMessage(
        fauxToolCall("searxng_web_search", { query: "second attempt" }, { id: "recovered-search" }),
        { stopReason: "toolUse" },
      ),
      (context) => {
        const result = context.messages.find(
          (message) => message.role === "toolResult" && message.toolCallId === "recovered-search",
        );
        const content = result?.role === "toolResult" ? result.content[0] : undefined;
        return fauxAssistantMessage(
          content?.type === "text" ? `Recovered search: ${content.text}` : "Missing search result.",
        );
      },
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    let searchCalls = 0;

    runtime = await createPiDurableAgentRuntime({
      sqlitePath: join(dir, "search-recovery.sqlite"),
      models,
      model: { provider: faux.provider.id, modelId: faux.getModel().id },
      retry: { enabled: false },
      searxng: {
        enabled: true,
        search: (query) => {
          searchCalls += 1;
          if (query === "first attempt") {
            return Promise.reject(new Error("SearXNG Environment unavailable."));
          }
          return Promise.resolve("synthetic recovered result");
        },
      },
    });
    server = await startDaemonServer({ host: "127.0.0.1", port: 0, agentRuntime: runtime });

    const client = await connectWs(server.port);
    client.sendJson(createHelloMessage());
    await client.nextMessage();
    const submit = (requestId: string, text: string) => {
      client.sendJson(createSubmitMessage({ threadId: DEFAULT_MAIN_THREAD_ID, requestId, text }));
    };
    submit("req-search-interrupted", "Search once");
    await client.nextMessage();
    const failedDeltas = await collectTurnDeltas(client);
    const failedReply = failedDeltas
      .filter((delta) => delta.event.kind === "text_delta")
      .map((delta) => (delta.event.kind === "text_delta" ? delta.event.delta : ""))
      .join("");
    expect(failedReply).toContain("Environment is unavailable");
    expect(searchCalls).toBe(1);

    submit("req-chat-during-outage", "Can you help without search?");
    await client.nextMessage();
    const chatDeltas = await collectTurnDeltas(client);
    expect(
      chatDeltas
        .filter((delta) => delta.event.kind === "text_delta")
        .map((delta) => (delta.event.kind === "text_delta" ? delta.event.delta : ""))
        .join(""),
    ).toBe("Ordinary conversation is still available.");
    expect(searchCalls).toBe(1);

    submit("req-search-recovered", "Search again");
    await client.nextMessage();
    const recoveredDeltas = await collectTurnDeltas(client);
    const recoveredReply = recoveredDeltas
      .filter((delta) => delta.event.kind === "text_delta")
      .map((delta) => (delta.event.kind === "text_delta" ? delta.event.delta : ""))
      .join("");
    expect(recoveredReply).toContain("synthetic recovered result");
    expect(searchCalls).toBe(2);
    expect(faux.state.callCount).toBe(5);
    await client.close();
  });

  it("keeps ordinary Threads available when the SearXNG Connector is disabled", async () => {
    const faux = fauxProvider({ tokensPerSecond: 10_000 });
    faux.setResponses([fauxAssistantMessage("Alfred is ready.")]);
    const models = createModels();
    models.setProvider(faux.provider);
    let searchCount = 0;

    runtime = await createPiDurableAgentRuntime({
      sqlitePath: join(makeTempDir(), "search-disabled.sqlite"),
      models,
      model: { provider: faux.provider.id, modelId: faux.getModel().id },
      retry: { enabled: false },
      searxng: {
        enabled: false,
        search: () => {
          searchCount += 1;
          return Promise.resolve("unexpected");
        },
      },
    });
    server = await startDaemonServer({ host: "127.0.0.1", port: 0, agentRuntime: runtime });

    const client = await connectWs(server.port);
    client.sendJson(createHelloMessage());
    await client.nextMessage();
    client.sendJson(
      createSubmitMessage({
        threadId: DEFAULT_MAIN_THREAD_ID,
        requestId: "req-search-disabled",
        text: "Hello Alfred",
      }),
    );
    await client.nextMessage();
    const deltas = await collectTurnDeltas(client);
    expect(
      deltas
        .filter((delta) => delta.event.kind === "text_delta")
        .map((delta) => (delta.event.kind === "text_delta" ? delta.event.delta : ""))
        .join(""),
    ).toBe("Alfred is ready.");
    expect(searchCount).toBe(0);
    expect(faux.state.callCount).toBe(1);
    await client.close();
  });

  it.skipIf(process.env.ALFRED_SEARXNG_PODMAN !== "1")(
    "searches from the existing Thread with the pinned rootless Podman image",
    async () => {
      const image = process.env.ALFRED_SEARXNG_IMAGE;
      if (image === undefined) {
        throw new Error("ALFRED_SEARXNG_IMAGE must identify the locally built pinned image.");
      }
      const faux = fauxProvider({ tokensPerSecond: 10_000 });
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("searxng_web_search", { query: "Alfred" }, { id: "podman-search" }),
          { stopReason: "toolUse" },
        ),
        (context) => {
          const result = context.messages.find(
            (message) => message.role === "toolResult" && message.toolCallId === "podman-search",
          );
          const content = result?.role === "toolResult" ? result.content[0] : undefined;
          const text = content?.type === "text" ? content.text : "missing search result";
          return fauxAssistantMessage(`Search says: ${text}`);
        },
      ]);
      const models = createModels();
      models.setProvider(faux.provider);
      runtime = await createPiDurableAgentRuntime({
        sqlitePath: join(makeTempDir(), "search-podman.sqlite"),
        models,
        model: { provider: faux.provider.id, modelId: faux.getModel().id },
        retry: { enabled: false },
        searxng: {
          enabled: true,
          image,
          ...(process.env.ALFRED_SEARXNG_CONTAINER !== undefined
            ? { containerName: process.env.ALFRED_SEARXNG_CONTAINER }
            : {}),
          ...(process.env.ALFRED_PODMAN_PATH !== undefined
            ? { podmanPath: process.env.ALFRED_PODMAN_PATH }
            : {}),
          ...(process.env.ALFRED_PODMAN_CONNECTION !== undefined
            ? { podmanConnection: process.env.ALFRED_PODMAN_CONNECTION }
            : {}),
        },
      });
      server = await startDaemonServer({ host: "127.0.0.1", port: 0, agentRuntime: runtime });
      const client = await connectWs(server.port);
      client.sendJson(createHelloMessage());
      await client.nextMessage();
      client.sendJson(
        createSubmitMessage({
          threadId: DEFAULT_MAIN_THREAD_ID,
          requestId: "req-search-podman",
          text: "Search for Alfred",
        }),
      );
      await client.nextMessage();
      const deltas = await collectTurnDeltas(client);
      const reply = deltas
        .filter((delta) => delta.event.kind === "text_delta")
        .map((delta) => (delta.event.kind === "text_delta" ? delta.event.delta : ""))
        .join("");
      expect(reply).toContain("Alfred synthetic search result");
      expect(reply).toContain("deterministic result from the synthetic SearXNG endpoint");
      await client.close();
    },
  );

  it.skipIf(process.env.ALFRED_SEARXNG_PODMAN !== "1")(
    "fails an interrupted Podman search and reconnects on the next Thread search",
    async () => {
      const image = process.env.ALFRED_SEARXNG_IMAGE;
      if (image === undefined) {
        throw new Error("ALFRED_SEARXNG_IMAGE must identify the locally built pinned image.");
      }
      const podman = process.env.ALFRED_PODMAN_PATH ?? "podman";
      const podmanArgs =
        process.env.ALFRED_PODMAN_CONNECTION !== undefined
          ? ["--connection", process.env.ALFRED_PODMAN_CONNECTION]
          : [];
      const containerName = `alfred-searxng-recovery-${String(process.pid)}-${String(Date.now())}`;
      const faux = fauxProvider({ tokensPerSecond: 10_000 });
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall(
            "searxng_web_search",
            { query: "alfred-hold-search" },
            { id: "held-search" },
          ),
          { stopReason: "toolUse" },
        ),
        () => fauxAssistantMessage("The SearXNG Environment became unavailable during the search."),
        fauxAssistantMessage("Ordinary conversation is still available during the outage."),
        fauxAssistantMessage(
          fauxToolCall("searxng_web_search", { query: "Alfred" }, { id: "recovered-search" }),
          { stopReason: "toolUse" },
        ),
        (context) => {
          const result = context.messages.find(
            (message) => message.role === "toolResult" && message.toolCallId === "recovered-search",
          );
          const content = result?.role === "toolResult" ? result.content[0] : undefined;
          return fauxAssistantMessage(
            content?.type === "text" ? `Recovered: ${content.text}` : "Missing recovered result.",
          );
        },
      ]);
      const models = createModels();
      models.setProvider(faux.provider);
      runtime = await createPiDurableAgentRuntime({
        sqlitePath: join(makeTempDir(), "search-podman-recovery.sqlite"),
        models,
        model: { provider: faux.provider.id, modelId: faux.getModel().id },
        retry: { enabled: false },
        searxng: {
          enabled: true,
          image,
          containerName,
          podmanPath: podman,
          ...(process.env.ALFRED_PODMAN_CONNECTION !== undefined
            ? { podmanConnection: process.env.ALFRED_PODMAN_CONNECTION }
            : {}),
        },
      });
      server = await startDaemonServer({ host: "127.0.0.1", port: 0, agentRuntime: runtime });
      const client = await connectWs(server.port);
      client.sendJson(createHelloMessage());
      await client.nextMessage();
      await execFileAsync(podman, [
        ...podmanArgs,
        "run",
        "--pull=never",
        "--name",
        containerName,
        "--label",
        "io.alfred.connector=searxng",
        "--network=none",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev",
        "-d",
        image,
      ]);
      client.sendJson(
        createSubmitMessage({
          threadId: DEFAULT_MAIN_THREAD_ID,
          requestId: "req-search-podman-interrupted",
          text: "Search and wait for interruption",
        }),
      );
      await client.nextMessage();

      const logReader = spawn(podman, [...podmanArgs, "logs", "--follow", containerName], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      await new Promise<void>((resolve, reject) => {
        let output = "";
        let errorOutput = "";
        logReader.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString("utf8");
          if (output.includes("synthetic search waiting")) {
            resolve();
          }
        });
        logReader.stderr.on("data", (chunk: Buffer) => {
          errorOutput += chunk.toString("utf8");
        });
        logReader.once("error", reject);
        logReader.once("exit", (code) => {
          reject(
            new Error(
              `Podman log stream exited before the hold marker (code ${String(code)}): ${errorOutput}`,
            ),
          );
        });
      });
      logReader.kill();
      await execFileAsync(podman, [...podmanArgs, "stop", "-t", "1", containerName]);

      const interruptedDeltas = await collectTurnDeltas(client);
      const interruptedReply = interruptedDeltas
        .filter((delta) => delta.event.kind === "text_delta")
        .map((delta) => (delta.event.kind === "text_delta" ? delta.event.delta : ""))
        .join("");
      expect(interruptedReply).toContain("Environment became unavailable");
      expect(faux.state.callCount).toBe(2);

      client.sendJson(
        createSubmitMessage({
          threadId: DEFAULT_MAIN_THREAD_ID,
          requestId: "req-chat-podman-outage",
          text: "Can you help without search?",
        }),
      );
      await client.nextMessage();
      const chatDeltas = await collectTurnDeltas(client);
      const chatReply = chatDeltas
        .filter((delta) => delta.event.kind === "text_delta")
        .map((delta) => (delta.event.kind === "text_delta" ? delta.event.delta : ""))
        .join("");
      expect(chatReply).toContain("Ordinary conversation is still available");
      expect(faux.state.callCount).toBe(3);

      client.sendJson(
        createSubmitMessage({
          threadId: DEFAULT_MAIN_THREAD_ID,
          requestId: "req-search-podman-recovered",
          text: "Search again after the Environment restarted",
        }),
      );
      await client.nextMessage();
      const recoveredDeltas = await collectTurnDeltas(client);
      const recoveredReply = recoveredDeltas
        .filter((delta) => delta.event.kind === "text_delta")
        .map((delta) => (delta.event.kind === "text_delta" ? delta.event.delta : ""))
        .join("");
      expect(recoveredReply).toContain("Alfred synthetic search result");
      expect(faux.state.callCount).toBe(5);
      await client.close();
    },
    45_000,
  );

  it("deduplicates requestId within one run and across SQLite reopens", async () => {
    const dir = makeTempDir();
    const sqlitePath = join(dir, "main.sqlite");

    const faux1 = fauxProvider({ tokensPerSecond: 10_000 });
    faux1.setResponses([
      fauxAssistantMessage("Single reply only."),
      fauxAssistantMessage("Should never be used."),
    ]);
    const models1 = createModels();
    models1.setProvider(faux1.provider);

    runtime = await createPiDurableAgentRuntime({
      sqlitePath,
      models: models1,
      model: { provider: faux1.provider.id, modelId: faux1.getModel().id },
      retry: { enabled: false },
    });
    server = await startDaemonServer({ host: "127.0.0.1", port: 0, agentRuntime: runtime });

    const client1 = await connectWs(server.port);
    client1.sendJson(createHelloMessage());
    await client1.nextMessage();

    client1.sendJson(
      createSubmitMessage({
        threadId: DEFAULT_MAIN_THREAD_ID,
        requestId: "req-idem-1",
        text: "Do this once",
      }),
    );

    const ack1 = await client1.nextMessage();
    expect(ack1.type).toBe("ack");
    const firstSubmissionId = ack1.type === "ack" ? ack1.submissionId : "";
    expect(ack1).toEqual({
      type: "ack",
      threadId: DEFAULT_MAIN_THREAD_ID,
      requestId: "req-idem-1",
      submissionId: firstSubmissionId,
      deduplicated: false,
    });

    await collectTurnDeltas(client1);

    // Duplicate within the same active daemon.
    client1.sendJson(
      createSubmitMessage({
        threadId: DEFAULT_MAIN_THREAD_ID,
        requestId: "req-idem-1",
        text: "Do this once",
      }),
    );

    const ack2 = await client1.nextMessage();
    expect(ack2).toEqual({
      type: "ack",
      threadId: DEFAULT_MAIN_THREAD_ID,
      requestId: "req-idem-1",
      submissionId: firstSubmissionId,
      deduplicated: true,
    });
    expect(faux1.state.callCount).toBe(1);

    await client1.close();
    await server.close();
    server = undefined;
    runtime = undefined;

    // Reopen on the same SQLite file and replay the same requestId.
    const faux2 = fauxProvider({ tokensPerSecond: 10_000 });
    faux2.setResponses([fauxAssistantMessage("Should never run after restart.")]);
    const models2 = createModels();
    models2.setProvider(faux2.provider);

    runtime = await createPiDurableAgentRuntime({
      sqlitePath,
      models: models2,
      model: { provider: faux2.provider.id, modelId: faux2.getModel().id },
      retry: { enabled: false },
    });
    server = await startDaemonServer({ host: "127.0.0.1", port: 0, agentRuntime: runtime });

    const client2 = await connectWs(server.port);
    client2.sendJson(createHelloMessage());
    const initialAfterRestart = await client2.nextMessage();
    expect(initialAfterRestart.type).toBe("snapshot");
    if (initialAfterRestart.type === "snapshot") {
      expect(initialAfterRestart.thread.messages).toHaveLength(2);
    }

    client2.sendJson(
      createSubmitMessage({
        threadId: DEFAULT_MAIN_THREAD_ID,
        requestId: "req-idem-1",
        text: "Do this once",
      }),
    );

    const ack3 = await client2.nextMessage();
    expect(ack3).toEqual({
      type: "ack",
      threadId: DEFAULT_MAIN_THREAD_ID,
      requestId: "req-idem-1",
      submissionId: firstSubmissionId,
      deduplicated: true,
    });
    expect(faux2.state.callCount).toBe(0);

    await client2.close();
  });

  it("sanitizes provider errors and surfaces missing auth or model init failures cleanly", async () => {
    const dir = makeTempDir();

    // 1) Provider stream error containing sensitive credentials.
    const fauxErr = fauxProvider({ tokensPerSecond: 10_000 });
    fauxErr.setResponses([
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage:
          "Upstream 401: Authorization: Bearer sk-live-secret-999999?api_key=topsecret123 rejected",
      }),
      fauxAssistantMessage("Recovered cleanly."),
    ]);
    const errModels = createModels();
    errModels.setProvider(fauxErr.provider);

    runtime = await createPiDurableAgentRuntime({
      sqlitePath: join(dir, "err-provider.sqlite"),
      models: errModels,
      model: { provider: fauxErr.provider.id, modelId: fauxErr.getModel().id },
      retry: { enabled: false },
    });
    server = await startDaemonServer({ host: "127.0.0.1", port: 0, agentRuntime: runtime });

    const client1 = await connectWs(server.port);
    client1.sendJson(createHelloMessage());
    await client1.nextMessage();

    client1.sendJson(
      createSubmitMessage({
        threadId: DEFAULT_MAIN_THREAD_ID,
        requestId: "req-err-1",
        text: "Trigger error",
      }),
    );
    await client1.nextMessage(); // ack
    const errDeltas = await collectTurnDeltas(client1);
    const errEvent = errDeltas.at(-1)?.event;
    expect(errEvent?.kind).toBe("turn_error");
    if (errEvent?.kind === "turn_error") {
      expect(errEvent.status).toBe("error");
      expect(errEvent.message).toContain("Upstream 401");
      expect(errEvent.message).toContain("[REDACTED]");
      expect(errEvent.message).not.toContain("sk-live-secret-999999");
      expect(errEvent.message).not.toContain("topsecret123");
    }
    const errSnap = await runtime.getSnapshot();
    expect(errSnap.status).toBe("error");
    expect(errSnap.messages).toHaveLength(2);
    expect(errSnap.messages[1]?.status).toBe("error");

    // Subsequent successful turn clears thread error status back to idle.
    client1.sendJson(
      createSubmitMessage({
        threadId: DEFAULT_MAIN_THREAD_ID,
        requestId: "req-err-recover",
        text: "Try again",
      }),
    );
    await client1.nextMessage(); // ack
    await collectTurnDeltas(client1);
    const recoveredSnap = await runtime.getSnapshot();
    expect(recoveredSnap.status).toBe("idle");
    expect(recoveredSnap.messages.at(-1)?.text).toBe("Recovered cleanly.");
    expect(recoveredSnap.messages.at(-1)?.status).toBe("complete");

    await client1.close();
    await server.close();
    server = undefined;
    runtime = undefined;

    // 2) Provider with missing credentials surfaces a clear non-secret error.
    const unauthProvider = createProvider({
      id: "unconfigured-provider",
      auth: {
        apiKey: {
          name: "API Key",
          resolve: () => Promise.resolve(undefined),
        },
      },
      models: [
        {
          id: "test-model",
          name: "Test Model",
          api: "faux",
          provider: "unconfigured-provider",
          baseUrl: "http://localhost:0",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 16_384,
          maxTokens: 1024,
        },
      ],
      api: {
        stream: fauxErr.provider.stream.bind(fauxErr.provider),
        streamSimple: fauxErr.provider.streamSimple.bind(fauxErr.provider),
      },
    });
    const unauthModels = createModels();
    unauthModels.setProvider(unauthProvider);

    runtime = await createPiDurableAgentRuntime({
      sqlitePath: join(dir, "unauth.sqlite"),
      models: unauthModels,
      model: { provider: "unconfigured-provider", modelId: "test-model" },
      retry: { enabled: false },
    });
    server = await startDaemonServer({ host: "127.0.0.1", port: 0, agentRuntime: runtime });

    const client2 = await connectWs(server.port);
    client2.sendJson(createHelloMessage());
    await client2.nextMessage();

    client2.sendJson(
      createSubmitMessage({
        threadId: DEFAULT_MAIN_THREAD_ID,
        requestId: "req-unauth-1",
        text: "Hello?",
      }),
    );
    await client2.nextMessage(); // ack
    await collectTurnDeltas(client2);
    const unauthSnap = await runtime.getSnapshot();
    expect(unauthSnap.status).toBe("error");
    expect(unauthSnap.messages.at(-1)?.status).toBe("error");
    expect(unauthSnap.messages.at(-1)?.text).toContain("not configured");

    await client2.close();
    await server.close();
    server = undefined;
    runtime = undefined;

    // 3) Failing async models loader (e.g. broken auth.json) does not crash startup; surfaces sanitized error on submit.
    runtime = await createPiDurableAgentRuntime({
      sqlitePath: join(dir, "broken-auth.sqlite"),
      models: () => Promise.reject(new Error("Failed loading auth.json with sk-ant-secret123456")),
      retry: { enabled: false },
    });
    server = await startDaemonServer({ host: "127.0.0.1", port: 0, agentRuntime: runtime });

    const client3 = await connectWs(server.port);
    client3.sendJson(createHelloMessage());
    await client3.nextMessage();

    client3.sendJson(
      createSubmitMessage({
        threadId: DEFAULT_MAIN_THREAD_ID,
        requestId: "req-broken-auth",
        text: "Are you there?",
      }),
    );
    await client3.nextMessage(); // ack
    await collectTurnDeltas(client3);
    const brokenSnap = await runtime.getSnapshot();
    expect(brokenSnap.status).toBe("error");
    expect(brokenSnap.messages.at(-1)?.status).toBe("error");
    expect(brokenSnap.messages.at(-1)?.text).toContain("Failed loading auth.json");
    expect(brokenSnap.messages.at(-1)?.text).not.toContain("sk-ant-secret123456");

    await client3.close();
  });

  it("loads Main Agent from .example.md fallback and prefers .local.md override", async () => {
    const dir = makeTempDir();
    const agentsDir = join(dir, "agents");
    const examplePath = join(agentsDir, "main.example.md");
    const localPath = join(agentsDir, "main.local.md");

    const faux = fauxProvider({ tokensPerSecond: 10_000 });
    faux.setResponses([
      (ctx) => {
        const systemMessage = ctx.messages.find((msg) => msg.role === "system");
        const systemText =
          systemMessage?.role === "system" ? getSystemMessageText(systemMessage) : "";
        return fauxAssistantMessage(
          `Prompt saw: ${systemText.includes("EXAMPLE_PROMPT") ? "example" : "other"}`,
        );
      },
      (ctx) => {
        const systemMessage = ctx.messages.find((msg) => msg.role === "system");
        const systemText =
          systemMessage?.role === "system" ? getSystemMessageText(systemMessage) : "";
        return fauxAssistantMessage(
          `Prompt saw: ${systemText.includes("LOCAL_OVERRIDE_PROMPT") ? "local" : "other"}`,
        );
      },
    ]);
    const models = createModels();
    models.setProvider(faux.provider);

    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      examplePath,
      `---\nname: Alfred\ndescription: Default example agent\nmodel: ${faux.provider.id}/${faux.getModel().id}\n---\n\nEXAMPLE_PROMPT\n`,
      "utf8",
    );

    // 1) Falls back to main.example.md when main.local.md is absent.
    runtime = await createPiDurableAgentRuntime({
      sqlitePath: join(dir, "agents-1.sqlite"),
      agentsDir,
      models,
      retry: { enabled: false },
    });
    const snap1 = await runtime.getSnapshot();
    expect(snap1.agentName).toBe("Alfred");
    let resolveDone1!: () => void;
    const done1Promise = new Promise<void>((resolve) => {
      resolveDone1 = resolve;
    });
    const sub1 = await runtime.subscribeThread(DEFAULT_MAIN_THREAD_ID, (delta) => {
      if (
        delta.event.kind === "turn_finish" &&
        delta.event.messageId !== `entry-1` &&
        !delta.event.messageId.startsWith("entry-")
      ) {
        resolveDone1();
      } else if (delta.event.kind === "turn_finish" && delta.seq > 2) {
        resolveDone1();
      }
    });
    await runtime.submit({
      threadId: DEFAULT_MAIN_THREAD_ID,
      requestId: "req-cfg-1",
      text: "Check instructions",
    });
    await done1Promise;
    sub1.unsubscribe();
    expect((await runtime.getSnapshot()).messages.at(-1)?.text).toBe("Prompt saw: example");
    await runtime.close?.();
    runtime = undefined;

    // 2) Prefers main.local.md over main.example.md when present.
    writeFileSync(
      localPath,
      `---\nname: Alfred Local\ndescription: Local override agent\nmodel: ${faux.provider.id}/${faux.getModel().id}\n---\n\nLOCAL_OVERRIDE_PROMPT\n`,
      "utf8",
    );
    runtime = await createPiDurableAgentRuntime({
      sqlitePath: join(dir, "agents-2.sqlite"),
      agentsDir,
      models,
      retry: { enabled: false },
    });
    const snap2 = await runtime.getSnapshot();
    expect(snap2.agentName).toBe("Alfred Local");
    let resolveDone2!: () => void;
    const done2Promise = new Promise<void>((resolve) => {
      resolveDone2 = resolve;
    });
    const sub2 = await runtime.subscribeThread(DEFAULT_MAIN_THREAD_ID, (delta) => {
      if (delta.event.kind === "turn_finish" && delta.seq > 2) {
        resolveDone2();
      }
    });
    await runtime.submit({
      threadId: DEFAULT_MAIN_THREAD_ID,
      requestId: "req-cfg-2",
      text: "Check local override",
    });
    await done2Promise;
    sub2.unsubscribe();
    expect((await runtime.getSnapshot()).messages.at(-1)?.text).toBe("Prompt saw: local");
  });

  it("streams incremental deltas live and resyncs mid-stream reconnect without losing or duplicating tokens", async () => {
    const dir = makeTempDir();
    const sqlitePath = join(dir, "streaming.sqlite");

    let resolveStreamStarted!: () => void;
    const streamStartedPromise = new Promise<void>((resolve) => {
      resolveStreamStarted = resolve;
    });
    let activeStream: AssistantMessageEventStream | undefined;

    const streamingProvider = createProvider({
      id: "controllable-provider",
      auth: {
        apiKey: {
          name: "API Key",
          resolve: () => Promise.resolve({ auth: { apiKey: "test-key" } }),
        },
      },
      models: [
        {
          id: "stream-model",
          name: "Stream Model",
          api: "faux",
          provider: "controllable-provider",
          baseUrl: "http://localhost:0",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 16_384,
          maxTokens: 1024,
        },
      ],
      api: {
        stream: () => {
          const s = createAssistantMessageEventStream();
          activeStream = s;
          resolveStreamStarted();
          return s;
        },
        streamSimple: () => {
          const s = createAssistantMessageEventStream();
          activeStream = s;
          resolveStreamStarted();
          return s;
        },
      },
    });
    const models = createModels();
    models.setProvider(streamingProvider);

    runtime = await createPiDurableAgentRuntime({
      sqlitePath,
      models,
      model: { provider: "controllable-provider", modelId: "stream-model" },
      retry: { enabled: false },
      progress: { partialIntervalMs: 0 },
    });
    server = await startDaemonServer({ host: "127.0.0.1", port: 0, agentRuntime: runtime });

    const client1 = await connectWs(server.port);
    client1.sendJson(createHelloMessage());
    const initSnap = await client1.nextMessage();
    expect(initSnap.type).toBe("snapshot");

    client1.sendJson(
      createSubmitMessage({
        threadId: DEFAULT_MAIN_THREAD_ID,
        requestId: "req-stream-1",
        text: "Stream please",
      }),
    );

    const ack = await client1.nextMessage();
    expect(ack.type).toBe("ack");

    // Owner turn_start + turn_finish arrive first.
    const ownerStart = await client1.nextMessage();
    const ownerFinish = await client1.nextMessage();
    expect(ownerStart.type).toBe("delta");
    expect(ownerFinish.type).toBe("delta");

    await streamStartedPromise;
    const stream = activeStream;
    if (stream === undefined) {
      throw new Error("Expected active stream");
    }

    const basePartial = (): AssistantMessage => ({
      role: "assistant",
      content: [{ type: "text", text: "Hello " }],
      api: "faux",
      provider: "controllable-provider",
      model: "stream-model",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "pending",
      timestamp: Date.now(),
    });

    const p1 = basePartial();
    stream.push({ type: "start", partial: { ...p1, content: [] } });
    stream.push({
      type: "text_start",
      contentIndex: 0,
      partial: { ...p1, content: [{ type: "text", text: "" }] },
    });
    stream.push({ type: "text_delta", contentIndex: 0, delta: "Hello ", partial: p1 });

    const agentStart = await client1.nextMessage();
    expect(agentStart.type).toBe("delta");
    if (agentStart.type === "delta") {
      expect(agentStart.event.kind).toBe("turn_start");
      if (agentStart.event.kind === "turn_start") {
        expect(agentStart.event.role).toBe("agent");
      }
    }

    const chunk1 = await client1.nextMessage();
    expect(chunk1.type).toBe("delta");
    if (chunk1.type === "delta") {
      expect(chunk1.event).toMatchObject({ kind: "text_delta", delta: "Hello " });
    }

    // Disconnect client1 mid-stream and connect client2 while stream is still open!
    await client1.close();

    const client2 = await connectWs(server.port);
    client2.sendJson(createHelloMessage());
    const midSnap = await client2.nextMessage();
    expect(midSnap.type).toBe("snapshot");
    let snapSeq = 0;
    let partialMessageId = "";
    if (midSnap.type === "snapshot") {
      snapSeq = midSnap.seq;
      expect(midSnap.thread.status).toBe("streaming");
      const lastMsg = midSnap.thread.messages.at(-1);
      expect(lastMsg?.role).toBe("agent");
      expect(lastMsg?.status).toBe("streaming");
      expect(lastMsg?.text).toBe("Hello ");
      partialMessageId = lastMsg?.id ?? "";
    }

    // Push remaining text and complete the stream.
    const p2: AssistantMessage = {
      ...basePartial(),
      content: [{ type: "text", text: "Hello world!" }],
    };
    stream.push({ type: "text_delta", contentIndex: 0, delta: "world!", partial: p2 });
    const finalMsg: AssistantMessage = {
      ...p2,
      stopReason: "stop",
    };
    stream.push({ type: "text_end", contentIndex: 0, content: "Hello world!", partial: finalMsg });
    stream.push({ type: "done", reason: "stop", message: finalMsg });

    const tailEvents: DeltaMessage[] = [];
    for (;;) {
      const msg = await client2.nextMessage();
      expect(msg.type).toBe("delta");
      if (msg.type === "delta") {
        expect(msg.seq).toBeGreaterThan(snapSeq);
        snapSeq = msg.seq;
        tailEvents.push(msg);
        if (msg.event.kind === "turn_finish") {
          break;
        }
      }
    }

    const appended = tailEvents
      .filter((d) => d.event.kind === "text_delta")
      .map((d) => {
        if (d.event.kind === "text_delta") {
          expect(d.event.messageId).toBe(partialMessageId);
          return d.event.delta;
        }
        return "";
      })
      .join("");
    expect(appended).toBe("world!");
    expect(tailEvents.at(-1)?.event).toEqual({
      kind: "turn_finish",
      messageId: partialMessageId,
      status: "complete",
    });

    const endSnap = await runtime.getSnapshot();
    expect(endSnap.status).toBe("idle");
    expect(endSnap.messages.at(-1)?.text).toBe("Hello world!");
    expect(endSnap.messages.at(-1)?.status).toBe("complete");

    await client2.close();
  });
});
