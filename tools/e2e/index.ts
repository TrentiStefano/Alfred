// Public entry point of @alfred/e2e: the end-to-end checks for Slice 1.
// `run-web-e2e.ts` and `run-desktop-smoke.ts` are thin CLI runners over these.
export { runWebE2e } from "./lib/web-e2e.ts";
export { runDesktopSmoke } from "./lib/desktop-smoke.ts";
export { isWebBuildStale } from "./lib/harness.ts";
