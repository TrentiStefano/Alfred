# Packages are deep modules

Applies to every workspace package in `packages/`, `apps/` and `tools/`. Enforced by `pnpm lint:boundaries` (dependency-cruiser, `.dependency-cruiser.cjs`).

```
packages/<name>/
  package.json   ← "exports": { ".": "./index.ts" }
  index.ts       ← entry point (public). Packages may expose several small root files.
  lib/           ← implementation: private, free to import each other.
  tests/         ← tests: import only entry points (`../index.ts`, `@alfred/<pkg>`).
```

**Entry-point boundary.** Code outside a package imports only its root files (by name, `@alfred/<pkg>`), never anything in a subfolder.

**Intra-package freedom.** A package's own files import each other freely.

**Tests through entry points.** `tests/` may import any package's entry points and its own fixtures, never `lib/`, not even its own. If something is untestable through the interface, deepen the interface.

**No cycles.**

**No barrels.** Don't funnel a whole subtree through one giant `index.ts`. Expose a few small entry points that delegate to `lib/`.

## Layers

| Package                | May import                                  |
| ---------------------- | ------------------------------------------- |
| `packages/protocol`    | nothing in the workspace, no Node built-ins |
| `packages/plugin-sdk`  | `@alfred/protocol`                          |
| `packages/connector-*` | `@alfred/plugin-sdk`, `@alfred/protocol`    |
| `apps/pwa`             | `@alfred/protocol`                          |
| `apps/daemon`          | any package (nothing may import the daemon) |

Connectors are flat packages named `packages/connector-<system>`, not nested under `packages/connectors/`.
