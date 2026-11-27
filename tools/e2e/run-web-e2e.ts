// CLI: `pnpm --filter @alfred/e2e test:web`. Set ALFRED_E2E_REBUILD=1 to force a Flutter Web rebuild.
import { runWebE2e } from "./index.ts";

await runWebE2e();
