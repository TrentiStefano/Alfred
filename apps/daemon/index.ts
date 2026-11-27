// Public entry point of the Alfred daemon.
export { describeDaemon } from "./lib/describe.ts";
export {
  startDaemonServer,
  type DaemonServer,
  type DaemonServerOptions,
} from "./lib/http-server.ts";
