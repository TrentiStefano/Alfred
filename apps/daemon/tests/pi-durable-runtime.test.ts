import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  createModels,
  createProvider,
  fauxAssistantMessage,
  fauxProvider,
  getSystemMessageText,
} from "@earendil-works/pi-ai";
import {
  DEFAULT_MAIN_AGENT_NAME,
  DEFAULT_MAIN_THREAD_ID,
  PROTOCOL_VERSION,
  createHelloMessage,
  createSubmitMessage,
  parseDaemonMessage,
  type DaemonMessage,
} from "@alfred/protocol";
import {
  createPiDurableAgentRuntime,
  startDaemonServer,
  type AgentRuntime,
  type DaemonServer,
} from "../index.ts";

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

    const updated = await client1.nextMessage();
    expect(updated.type).toBe("snapshot");
    if (updated.type === "snapshot") {
      expect(updated.thread.status).toBe("idle");
      expect(updated.thread.messages).toHaveLength(2);
      expect(updated.thread.messages[0]?.role).toBe("owner");
      expect(updated.thread.messages[0]?.text).toBe("Hello Alfred");
      expect(updated.thread.messages[0]?.requestId).toBe("req-persist-1");
      expect(updated.thread.messages[1]?.role).toBe("agent");
      expect(updated.thread.messages[1]?.text).toBe("Good morning, Owner.");
      expect(updated.thread.messages[1]?.status).toBe("complete");
    }

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

    const snapshot1 = await client1.nextMessage();
    expect(snapshot1.type).toBe("snapshot");

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
    const errSnap = await client1.nextMessage();
    expect(errSnap.type).toBe("snapshot");
    if (errSnap.type === "snapshot") {
      expect(errSnap.thread.status).toBe("error");
      expect(errSnap.thread.messages).toHaveLength(2);
      const agentMsg = errSnap.thread.messages[1];
      expect(agentMsg?.role).toBe("agent");
      expect(agentMsg?.status).toBe("error");
      expect(agentMsg?.text).toContain("Upstream 401");
      expect(agentMsg?.text).toContain("[REDACTED]");
      expect(agentMsg?.text).not.toContain("sk-live-secret-999999");
      expect(agentMsg?.text).not.toContain("topsecret123");
    }

    // Subsequent successful turn clears thread error status back to idle.
    client1.sendJson(
      createSubmitMessage({
        threadId: DEFAULT_MAIN_THREAD_ID,
        requestId: "req-err-recover",
        text: "Try again",
      }),
    );
    await client1.nextMessage(); // ack
    const recoveredSnap = await client1.nextMessage();
    expect(recoveredSnap.type).toBe("snapshot");
    if (recoveredSnap.type === "snapshot") {
      expect(recoveredSnap.thread.status).toBe("idle");
      expect(recoveredSnap.thread.messages.at(-1)?.text).toBe("Recovered cleanly.");
      expect(recoveredSnap.thread.messages.at(-1)?.status).toBe("complete");
    }

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
    const unauthSnap = await client2.nextMessage();
    expect(unauthSnap.type).toBe("snapshot");
    if (unauthSnap.type === "snapshot") {
      expect(unauthSnap.thread.status).toBe("error");
      expect(unauthSnap.thread.messages.at(-1)?.status).toBe("error");
      expect(unauthSnap.thread.messages.at(-1)?.text).toContain("not configured");
    }

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
    const brokenSnap = await client3.nextMessage();
    expect(brokenSnap.type).toBe("snapshot");
    if (brokenSnap.type === "snapshot") {
      expect(brokenSnap.thread.status).toBe("error");
      expect(brokenSnap.thread.messages.at(-1)?.status).toBe("error");
      expect(brokenSnap.thread.messages.at(-1)?.text).toContain("Failed loading auth.json");
      expect(brokenSnap.thread.messages.at(-1)?.text).not.toContain("sk-ant-secret123456");
    }

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
    const res1 = await runtime.submit({
      threadId: DEFAULT_MAIN_THREAD_ID,
      requestId: "req-cfg-1",
      text: "Check instructions",
    });
    expect(res1.snapshot.messages.at(-1)?.text).toBe("Prompt saw: example");
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
    const res2 = await runtime.submit({
      threadId: DEFAULT_MAIN_THREAD_ID,
      requestId: "req-cfg-2",
      text: "Check local override",
    });
    expect(res2.snapshot.messages.at(-1)?.text).toBe("Prompt saw: local");
  });
});
