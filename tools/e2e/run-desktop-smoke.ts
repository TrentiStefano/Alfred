// CLI: `pnpm --filter @alfred/e2e test:desktop`. Set ALFRED_E2E_SKIP_DESKTOP_BUILD=1 to reuse a build.
import { runDesktopSmoke } from "./index.ts";

await runDesktopSmoke();
