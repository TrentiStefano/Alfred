// @ts-check
// Module boundaries for Alfred (from the `setup-ts-deep-modules` skill, adapted to three roots).
//
// 1. DEEP MODULES. Every workspace package under packages/, apps/ or tools/ is a deep module.
//    Its PUBLIC SURFACE is its ENTRY POINTS: the files at the package root (index.ts, …).
//    Anything in a subfolder (lib/, tests/, …) is private. See packages/README.md.
// 2. LAYERS. Which packages may depend on which (the four Alfred layer rules, see AGENTS.md).

/** Workspace roots. One immediate child dir per package (flat, no nesting). */
const R = "(?:packages|apps|tools)";

/** A package's private internals: anything nested inside a package subfolder. */
const PACKAGE_INTERNALS = `^${R}/[^/]+/[^/]+/`;

/** Every workspace package, by real path (workspace imports resolve through symlinks). */
const ANY_PACKAGE = `^${R}/`;

/**
 * @param {string} name
 * @param {string} fromPkg path regex of the importing package
 * @param {string[]} allowed path regexes the package may import from the workspace
 * @param {string} fix prescriptive message
 * @returns {import('dependency-cruiser').IForbiddenRuleType}
 */
function layer(name, fromPkg, allowed, fix) {
  return {
    name,
    comment: fix,
    severity: "error",
    from: { path: fromPkg },
    to: { path: ANY_PACKAGE, pathNot: [fromPkg, ...allowed] },
  };
}

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // --- Deep modules ---------------------------------------------------------
    {
      name: "entrypoint-boundary-from-app",
      comment:
        "Root code may import a package's entry points (its root files), never its subfolders. Import the package by name (e.g. `@alfred/protocol`) or via its root file, and export what you need from an entry point.",
      severity: "error",
      from: { pathNot: ANY_PACKAGE },
      to: { path: PACKAGE_INTERNALS },
    },
    {
      name: "entrypoint-boundary-across-packages",
      comment:
        "A package may reach OTHER packages only through their entry points, never their internals. Import `@alfred/<pkg>` instead, and if something is missing, export it from that package's root file.",
      severity: "error",
      from: { path: `^${R}/([^/]+)/`, pathNot: `^${R}/[^/]+/tests/` },
      to: { path: PACKAGE_INTERNALS, pathNot: `^${R}/$1/` },
    },
    {
      name: "tests-through-entrypoints",
      comment:
        "Tests exercise a package through its entry points like everyone else. Import `../index.ts` (or another root file), never `../lib/...`. If a behaviour is untestable that way, the interface is too shallow: deepen it.",
      severity: "error",
      from: { path: `^${R}/([^/]+)/tests/` },
      to: { path: PACKAGE_INTERNALS, pathNot: `^${R}/$1/tests/` },
    },
    {
      name: "tests-folder-is-private",
      comment:
        "A package's tests/ folder is reachable only from tests. Move shared fixtures out of tests/.",
      severity: "error",
      from: { pathNot: `^${R}/[^/]+/tests/` },
      to: { path: `^${R}/[^/]+/tests/` },
    },
    {
      name: "no-circular",
      comment:
        "No dependency cycles. Extract the shared part into a lower layer (usually @alfred/protocol).",
      severity: "error",
      from: {},
      to: { circular: true },
    },

    {
      name: "no-unresolvable",
      comment:
        "This import does not resolve. Add the package to this workspace package's own package.json (`workspace:*` for @alfred/*) and run `pnpm install`, or fix the path.",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },

    // --- Alfred layers --------------------------------------------------------
    layer(
      "protocol-is-a-leaf",
      "^packages/protocol/",
      [],
      "packages/protocol is pure schemas and types: it may not import any other workspace package. Move the shared type INTO protocol instead.",
    ),
    {
      name: "protocol-has-no-io",
      comment:
        "packages/protocol is pure: no Node built-ins (fs, net, http, process, …). Do I/O in apps/daemon and pass plain data in.",
      severity: "error",
      from: { path: "^packages/protocol/", pathNot: "^packages/protocol/tests/" },
      to: { dependencyTypes: ["core"] },
    },
    layer(
      "plugin-sdk-only-uses-protocol",
      "^packages/plugin-sdk/",
      ["^packages/protocol/"],
      "packages/plugin-sdk may import only @alfred/protocol. Put daemon behaviour behind an interface in the SDK and implement it in apps/daemon.",
    ),
    layer(
      "connectors-only-use-sdk",
      "^packages/connector-[^/]+/",
      ["^packages/plugin-sdk/", "^packages/protocol/"],
      "Connectors (packages/connector-*) may import only @alfred/plugin-sdk and @alfred/protocol, never apps/daemon or another Connector. Ask the daemon for what you need through the ConnectorPlugin contract.",
    ),
    layer(
      "nothing-imports-the-daemon",
      "^(?:packages|tools)/",
      ["^packages/", "^tools/"],
      "Nothing may import apps/daemon: it is the top layer. Move the shared piece into packages/protocol or packages/plugin-sdk.",
    ),
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "^\\.claude/" },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    combinedDependencies: true,
    enhancedResolveOptions: {
      extensions: [".ts", ".tsx", ".js", ".jsx", ".json"],
      conditionNames: ["import", "node", "default"],
      exportsFields: ["exports"],
    },
  },
};
