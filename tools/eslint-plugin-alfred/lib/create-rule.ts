import { ESLintUtils } from "@typescript-eslint/utils";

export const createRule = ESLintUtils.RuleCreator(
  (name) =>
    `https://github.com/TrentiStefano/Alfred/blob/main/tools/eslint-plugin-alfred/README.md#${name}`,
);
