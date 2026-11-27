import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPiDurableAgentRuntime, installSignalShutdown, startDaemonServer } from "./index.ts";

const host = process.env.ALFRED_DAEMON_HOST ?? "127.0.0.1";
const port = Number(process.env.ALFRED_DAEMON_PORT ?? "4040");
const defaultDataDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
const dataDir = resolve(process.env.ALFRED_DATA_DIR ?? defaultDataDir);
const sqlitePath = join(dataDir, "main.sqlite");

const agentRuntime = await createPiDurableAgentRuntime({ sqlitePath });
const server = await startDaemonServer({ host, port, agentRuntime });
process.stdout.write(`alfred-daemon listening on http://${host}:${String(server.port)}\n`);

installSignalShutdown({
  close: () => server.close(),
  onSignal: (signal) => {
    process.stdout.write(`alfred-daemon shutting down on ${signal}\n`);
  },
});
