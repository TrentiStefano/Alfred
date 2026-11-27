import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Connection, openProcess, RemoteExecutionEnv } from "@earendil-works/pi-env";
import { McpClient, PipeTransport } from "@earendil-works/pi-mcp";
import { defineExtension, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { obj, str, type Schema } from "@earendil-works/pi-schema";
import type { RiskLevel } from "@alfred/plugin-sdk";
import { sanitizeErrorMessage } from "./sanitize-error.ts";

const execFileAsync = promisify(execFile);
const SEARCH_TOOL_NAME = "searxng_web_search";
const MCP_TOOL_NAME = "searxng_web_search";
const NODE_COMMAND = "/usr/local/bin/node";
const MCP_COMMAND = "/opt/alfred/node_modules/mcp-searxng/dist/cli.js";
const PI_ENV_COMMAND = "/usr/local/bin/pi-env";
const SYNTHETIC_ENDPOINT = "http://127.0.0.1:8080";
const CONTAINER_LABEL = "io.alfred.connector";
const CONTAINER_LABEL_VALUE = "searxng";

export const SEARXNG_SEARCH_CONTRACT = {
  tool: SEARCH_TOOL_NAME,
  risk: "read",
} as const;

export interface SearxngRuntimeConfig {
  enabled: boolean;
  image?: string;
  containerName?: string;
  podmanPath?: string;
  podmanConnection?: string;
  search?: (query: string) => Promise<string>;
}

export interface SearxngConnector {
  extension: ReturnType<typeof defineExtension>;
  environment(): Promise<ExecutionEnv>;
  close(): Promise<void>;
}

function validateImage(image: string | undefined): string {
  if (image === undefined || !/(?:@)?sha256:[a-f0-9]{64}$/i.test(image)) {
    throw new Error("SearXNG Connector requires a locally built image pinned by sha256 digest.");
  }
  return image;
}

export function createSearxngConnector(config: SearxngRuntimeConfig): SearxngConnector {
  let connection: Connection | undefined;
  let environment: RemoteExecutionEnv | undefined;
  let client: McpClient | undefined;
  let containerStarted = false;
  let startPromise: Promise<void> | undefined;

  async function ensureContainer(): Promise<void> {
    startPromise ??= (async () => {
      const image = validateImage(config.image);
      const podman = config.podmanPath ?? "podman";
      const containerName = config.containerName ?? "alfred-searxng";
      const prefix =
        config.podmanConnection !== undefined ? ["--connection", config.podmanConnection] : [];
      const rootless = await execFileAsync(
        podman,
        [...prefix, "info", "--format", "{{.Host.Security.Rootless}}"],
        { timeout: 15_000 },
      );
      if (rootless.stdout.trim() !== "true") {
        throw new Error("Podman is not using a rootless engine.");
      }
      const inspected = await execFileAsync(
        podman,
        [
          ...prefix,
          "inspect",
          "--format",
          `{{.State.Running}}|{{index .Config.Labels "${CONTAINER_LABEL}"}}`,
          containerName,
        ],
        { timeout: 15_000 },
      ).catch(() => undefined);
      if (inspected !== undefined) {
        const [running, ownerLabel] = inspected.stdout.trim().split("|");
        if (ownerLabel !== CONTAINER_LABEL_VALUE) {
          throw new Error("The configured SearXNG container name is already in use.");
        }
        if (running !== "true") {
          await execFileAsync(podman, [...prefix, "start", containerName], { timeout: 30_000 });
        }
        containerStarted = true;
        return;
      }
      const args = [
        ...prefix,
        "run",
        "--pull=never",
        "--name",
        containerName,
        "--label",
        `${CONTAINER_LABEL}=${CONTAINER_LABEL_VALUE}`,
        "--network=none",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev",
        "-d",
        image,
      ];
      try {
        await execFileAsync(podman, args, { timeout: 30_000 });
      } catch (error) {
        throw new Error("Could not start the SearXNG Environment.", { cause: error });
      }
      containerStarted = true;
    })();
    try {
      await startPromise;
    } catch (error) {
      containerStarted = false;
      throw error;
    } finally {
      startPromise = undefined;
    }
  }

  async function discardClient(): Promise<void> {
    const staleClient = client;
    const staleConnection = connection;
    client = undefined;
    connection = undefined;
    environment = undefined;
    try {
      await staleClient?.close();
    } finally {
      staleConnection?.close();
    }
  }

  async function ensureClient(): Promise<McpClient> {
    if (config.search !== undefined) {
      throw new Error("Synthetic test adapter does not use an MCP client.");
    }
    await ensureContainer();
    if (client !== undefined && client.connectionState === "connected") {
      return client;
    }
    await client?.close();
    connection ??= new Connection({
      command: [
        config.podmanPath ?? "podman",
        ...(config.podmanConnection !== undefined ? ["--connection", config.podmanConnection] : []),
        "exec",
        "-i",
        config.containerName ?? "alfred-searxng",
        PI_ENV_COMMAND,
      ],
    });
    const nextClient = new McpClient({ name: "alfred-searxng", version: "1.0.0" });
    await nextClient.connect(
      new PipeTransport({
        open: async (handlers) => {
          const process = await openProcess(connection as Connection, {
            argv: [NODE_COMMAND, MCP_COMMAND],
            cwd: "/opt/alfred",
            env: { SEARXNG_URL: SYNTHETIC_ENDPOINT },
            inheritEnv: false,
            onStdout(bytes) {
              handlers.onStdout(bytes);
            },
            onStderr(bytes) {
              handlers.onStderr(bytes);
            },
          });
          return process;
        },
      }),
    );
    const advertised = await nextClient.listTools();
    if (!advertised.some((tool) => tool.name === MCP_TOOL_NAME)) {
      await nextClient.close();
      throw new Error("Pinned SearXNG server did not expose the expected searxng_web_search Tool.");
    }
    client = nextClient;
    return nextClient;
  }

  async function search(query: string): Promise<string> {
    if (config.search !== undefined) {
      return config.search(query);
    }
    let serviceError = false;
    let emptyResult = false;
    try {
      const activeClient = await ensureClient();
      const result = await activeClient.callTool(MCP_TOOL_NAME, { query });
      if (result.isError === true) {
        serviceError = true;
        const message = result.content
          .map((item) => (item.type === "text" ? item.text : ""))
          .join("\n");
        throw new Error(sanitizeErrorMessage(message, "SearXNG search failed in its Environment."));
      }
      const text = result.content
        .filter((item): item is Extract<typeof item, { type: "text" }> => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      if (text.length === 0) {
        emptyResult = true;
        throw new Error("SearXNG search returned no readable result.");
      }
      return text;
    } catch (error) {
      await discardClient();
      if (serviceError || emptyResult) {
        throw error;
      }
      throw new Error("SearXNG Environment or private MCP connection is unavailable.", {
        cause: error,
      });
    }
  }

  const tool = {
    name: SEARXNG_SEARCH_CONTRACT.tool,
    description: "Search the configured synthetic SearXNG endpoint. Risk level: read.",
    parameters: obj({ query: str({ minLength: 1, maxLength: 500 }) }),
    risk: "read",
    replay: "unsafe",
    execute: async ({ query }) => ({
      output: [{ type: "text", text: await search(query) }],
    }),
  } satisfies ToolRegistration<Schema<{ query: string }>> & { risk: RiskLevel };
  const extension = defineExtension({
    name: "searxng",
    tools: [tool],
  });

  return {
    extension,
    async environment() {
      await ensureContainer();
      connection ??= new Connection({
        command: [
          config.podmanPath ?? "podman",
          ...(config.podmanConnection !== undefined
            ? ["--connection", config.podmanConnection]
            : []),
          "exec",
          "-i",
          config.containerName ?? "alfred-searxng",
          PI_ENV_COMMAND,
        ],
      });
      environment ??= new RemoteExecutionEnv({
        connection,
        id: "environment:main:searxng",
        cwd: "/tmp",
      });
      return environment;
    },
    async close() {
      if (!containerStarted) {
        await client?.close();
        connection?.close();
        return;
      }
      const podman = config.podmanPath ?? "podman";
      const prefix =
        config.podmanConnection !== undefined ? ["--connection", config.podmanConnection] : [];
      try {
        await execFileAsync(
          podman,
          [...prefix, "stop", "-t", "3", config.containerName ?? "alfred-searxng"],
          { timeout: 10_000 },
        );
      } finally {
        await client?.close();
        connection?.close();
        await execFileAsync(podman, [...prefix, "rm", config.containerName ?? "alfred-searxng"], {
          timeout: 10_000,
        });
      }
    },
  };
}

export function searxngRiskLevel(): RiskLevel {
  return "read";
}
