import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{packages,apps,tools}/*/tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", ".claude/**"],
    passWithNoTests: false,
  },
});
