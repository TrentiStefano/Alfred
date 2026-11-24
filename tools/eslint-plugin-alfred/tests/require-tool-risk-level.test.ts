import { rules } from "../index.ts";
import { ruleTester } from "./rule-tester.ts";

ruleTester.run("require-tool-risk-level", rules["require-tool-risk-level"], {
  valid: [
    `defineTool({ name: "search_documents", risk: "read" });`,
    `sdk.defineTool({ name: "create_event", "risk": "write" });`,
    `const t: ConnectorTool = { name: "delete_document", risk: "destructive" };`,
    `const t = { name: "today", risk: "read" } satisfies ConnectorTool;`,
    // Unrelated objects are none of this rule's business.
    `const config = { name: "x" };`,
    `other({ name: "x" });`,
  ],
  invalid: [
    { code: `defineTool({ name: "search_documents" });`, errors: [{ messageId: "missingRisk" }] },
    {
      code: `const t: ConnectorTool = { name: "x", ...base };`,
      errors: [{ messageId: "missingRisk" }],
    },
    {
      code: `const t = { name: "x" } satisfies ConnectorTool;`,
      errors: [{ messageId: "missingRisk" }],
    },
    {
      code: `defineTool({ name: "x", risk: level });`,
      errors: [{ messageId: "nonLiteralRisk" }],
    },
    {
      code: `defineTool({ name: "x", risk: "admin" });`,
      errors: [{ messageId: "nonLiteralRisk" }],
    },
  ],
});
