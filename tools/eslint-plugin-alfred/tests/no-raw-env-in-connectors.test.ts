import { rules } from "../index.ts";
import { ruleTester } from "./rule-tester.ts";

ruleTester.run("no-raw-env-in-connectors", rules["no-raw-env-in-connectors"], {
  valid: [
    `const token = secrets.get("paperless.token");`,
    `import { argv } from "node:process";`,
    `const env = { a: 1 }; env.a;`,
  ],
  invalid: [
    { code: `const t = process.env.PAPERLESS_TOKEN;`, errors: [{ messageId: "rawEnv" }] },
    { code: `const { TOKEN } = process.env;`, errors: [{ messageId: "rawEnv" }] },
    { code: `import { env } from "node:process";`, errors: [{ messageId: "rawEnv" }] },
    { code: `import proc from "process";`, errors: [{ messageId: "rawEnv" }] },
    { code: `import * as proc from "node:process";`, errors: [{ messageId: "rawEnv" }] },
  ],
});
