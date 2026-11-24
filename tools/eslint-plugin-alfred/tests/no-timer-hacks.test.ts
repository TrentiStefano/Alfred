import { rules } from "../index.ts";
import { ruleTester } from "./rule-tester.ts";

ruleTester.run("no-timer-hacks", rules["no-timer-hacks"], {
  valid: [
    `vi.useFakeTimers(); await vi.advanceTimersByTimeAsync(1000);`,
    `await once(emitter, "ready");`,
    `clearTimeout(handle);`,
  ],
  invalid: [
    {
      code: `await new Promise((r) => setTimeout(r, 100));`,
      errors: [{ messageId: "realTimer" }],
    },
    { code: `globalThis.setInterval(tick, 10);`, errors: [{ messageId: "realTimer" }] },
    { code: `setImmediate(done);`, errors: [{ messageId: "realTimer" }] },
    {
      code: `import { setTimeout as sleep } from "node:timers/promises";`,
      errors: [{ messageId: "realTimer" }],
    },
  ],
});
