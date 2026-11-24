# eslint-plugin-alfred

Alfred's own lint rules. Every message tells the agent what to do instead.

## require-tool-risk-level

Every `ConnectorTool` (a `defineTool({...})` call, or an object typed or `satisfies` `ConnectorTool`) declares `risk: 'read' | 'write' | 'destructive'` as an inline literal. Anything not `read` becomes an Approval.

## no-raw-env-in-connectors

Applies to `packages/connector-*`. No `process.env` or `env` imports from `node:process`: read config and secrets from the `SecretStore` passed to `init()`, so they stay scoped to one Environment and redactable.

## no-timer-hacks

Applies to test files. No `setTimeout` / `setInterval` / `setImmediate` or `timers` imports: await the real event, or use `vi.useFakeTimers()`.

## Adding a rule

After `/retro`, encode each recurring agent mistake as a rule here: `lib/rules/<name>.ts`, registered in `index.ts`, with a `tests/<name>.test.ts` RuleTester suite, then enable it in `eslint.config.ts`.
