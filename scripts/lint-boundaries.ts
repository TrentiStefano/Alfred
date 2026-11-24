// Runs dependency-cruiser through its API with `.dependency-cruiser.cjs`.
// (The `depcruise` CLI refuses odd-numbered, end-of-life Node releases; the API does not.)
import { cruise, format, type ICruiseResult } from "dependency-cruiser";
import extractDepcruiseOptions from "dependency-cruiser/config-utl/extract-depcruise-options";
import extractTSConfig from "dependency-cruiser/config-utl/extract-ts-config";

export const BOUNDARY_ROOTS = ["packages", "apps", "tools", "scripts"];

const options = await extractDepcruiseOptions("./.dependency-cruiser.cjs");
const tsConfig = extractTSConfig("tsconfig.json");
const reported = await cruise(BOUNDARY_ROOTS, options, {}, { tsConfig });
const result = reported.output as ICruiseResult;
const errors = result.summary.error;

const pretty = await format(result, { outputType: "err-long" });
process.stdout.write(
  typeof pretty.output === "string" ? pretty.output : JSON.stringify(pretty.output),
);
if (errors > 0) {
  process.stderr.write(
    `\n${String(errors)} boundary violation(s). Each message above says how to fix it; see packages/README.md.\n`,
  );
  process.exitCode = 1;
}
