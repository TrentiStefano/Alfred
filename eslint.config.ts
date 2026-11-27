import eslintComments from "@eslint-community/eslint-plugin-eslint-comments";
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import alfred from "./tools/eslint-plugin-alfred/index.ts";

const TEST_FILES = ["**/tests/**/*.ts", "**/*.test.ts"];

export default defineConfig(
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/coverage/**", ".claude/**", ".agents/**"],
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: "error",
      reportUnusedInlineConfigs: "error",
    },
  },
  js.configs.recommended,
  {
    // Zero escape hatches, in every file: fix the code, or change the rule here in review.
    plugins: { "@eslint-community/eslint-comments": eslintComments },
    rules: { "@eslint-community/eslint-comments/no-use": ["error", { allow: [] }] },
  },
  {
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { module: "writable", require: "readonly" },
    },
  },
  {
    files: ["**/*.ts"],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { alfred },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-expect-error": true,
          "ts-ignore": true,
          "ts-nocheck": true,
          "ts-check": false,
        },
      ],
      "alfred/require-tool-risk-level": "error",
    },
  },
  {
    files: ["packages/connector-*/**/*.ts"],
    rules: { "alfred/no-raw-env-in-connectors": "error" },
  },
  {
    files: TEST_FILES,
    rules: { "alfred/no-timer-hacks": "error" },
  },
);
