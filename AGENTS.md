# Alfred

Self-hosted, privacy-first personal assistant: an always-on daemon (Pi + Pi Durable) and an iPhone PWA.
Domain language lives in `GLOSSARY.md`; use its terms (Owner, Agent, Environment, Connector, Tool, Risk level, Approval…).

## Done means verified

Run `pnpm verify` (or `./scripts/verify`). It runs format, typecheck, lint, boundaries, tests and repo checks, and exits 0 only if all pass. Never finish a task with it failing.

No escape hatches: `eslint-disable`, `@ts-ignore`, `@ts-expect-error` and `@ts-nocheck` are lint errors. Fix the code.

## Map

```
apps/daemon/               always-on server (Pi Durable runtime, Approvals, MCP bridge, Web Push)
apps/pwa/                  iPhone PWA (Chat, Approvals inbox, Live state)
packages/protocol/         pure Zod schemas + types, zero I/O
packages/plugin-sdk/       Connector contract, RiskLevel, contract test suite
packages/connector-<name>/ native Connectors (flat, one package each)
tools/eslint-plugin-alfred custom lint rules with prescriptive messages
scripts/                   verify, lint-boundaries, check-repo
specs/                     ephemeral specs `YYYY-MM-DD-feature.md`, archived on merge
docs/adr/                  architectural decision records
docs/agents/               skill config (issue tracker, triage labels, domain docs)
```

## Layer rules (enforced by `pnpm lint:boundaries`)

1. `packages/protocol` imports no workspace package and no Node built-ins.
2. `packages/plugin-sdk` imports only `@alfred/protocol`.
3. `packages/connector-*` import only `@alfred/plugin-sdk` and `@alfred/protocol`.
4. `apps/pwa` imports only `@alfred/protocol`. Nothing imports `apps/daemon`.

Packages are deep modules: see [packages/README.md](packages/README.md) before adding or importing one.

## Public repo: no personal data

Real config (`.env`, `connectors.yaml`, compose files, Tailscale, provider auth) stays on the Owner's machine and is gitignored. Commit only `*.example.*` placeholders with fake hosts and tokens. `pnpm check:repo` fails if a local-only file is tracked. Never put names, hostnames, amounts or medical/financial details in code, tests, issues or commits.

## Workflow

Non-trivial features: `/grill-with-docs` → `/to-spec` (into `specs/`) → `/to-tickets` → `/implement` → `/code-review`. After merging, `/retro`, and encode each recurring mistake as a rule in `tools/eslint-plugin-alfred` or `scripts/`.

## Agent skills

### Issue tracker

Issues, specs and wayfinder maps live in GitHub Issues for `TrentiStefano/Alfred` (via `gh`). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.
