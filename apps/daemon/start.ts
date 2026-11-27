import { startDaemonServer } from "./index.ts";

const host = process.env.ALFRED_DAEMON_HOST ?? "127.0.0.1";
const port = Number(process.env.ALFRED_DAEMON_PORT ?? "4040");

const server = await startDaemonServer({ host, port });
process.stdout.write(`alfred-daemon listening on http://${host}:${String(server.port)}\n`);
