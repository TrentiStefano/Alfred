# How Pi and Pi Durable embed in Alfred's daemon

Research for [issue #2](https://github.com/TrentiStefano/Alfred/issues/2). Snapshot taken 2026-11-24 against
`@earendil-works/*@1.6.0` (released 2026-11-20). Terms follow [GLOSSARY.md](../../GLOSSARY.md).

## Sources

All primary. Monorepo: [earendil-works/pi](https://github.com/earendil-works/pi) (MIT).

| Short name | Source |
|---|---|
| **DUR** | [`packages/durable/README.md`](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md) (also shipped in the npm tarball of `@earendil-works/pi-durable@1.6.0`) |
| **DUR-CL** | [`packages/durable/CHANGELOG.md`](https://github.com/earendil-works/pi/blob/main/packages/durable/CHANGELOG.md) |
| **DUR-TYPES** | `@earendil-works/pi-durable@1.6.0`, `dist/harness/types.d.ts` (`HarnessOptions`) |
| **DUR-SPEC** | [`packages/durable/docs/spec.md`](https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md) (normative spec, linked from DUR) |
| **AI** | [`packages/ai/README.md`](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md) |
| **MCP** | [`packages/mcp/README.md`](https://github.com/earendil-works/pi/blob/main/packages/mcp/README.md) |
| **ENV** | [`packages/env/README.md`](https://github.com/earendil-works/pi/blob/main/packages/env/README.md) |
| **SDK** | [`packages/coding-agent/docs/sdk.md`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md) |
| **MR** | [`packages/coding-agent/src/core/model-runtime.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/model-runtime.ts) (and its `dist/core/model-runtime.d.ts`) |
| **CFG** | [`packages/coding-agent/docs/configuration.md`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/configuration.md), [`providers.md`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md), [`mcp.md`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md) |
| **NPM** | `npm view @earendil-works/pi-durable time` / `dependencies` (registry metadata) |

## Package map

Two different embedding surfaces exist, on separate stacks:

- **`@earendil-works/pi-coding-agent`** (the `pi` CLI) exposes an SDK, `createAgentSession()`, built on
  `@earendil-works/pi-agent-core`; sessions are JSONL files managed by `SessionManager` (SDK). It does **not** depend
  on `pi-durable` (NPM: its dependency list has `pi-agent-core`, `pi-ai`, `pi-mcp`, `pi-tui`, `pi-codemode`, no
  `pi-durable`).
- **`@earendil-works/pi-durable`** is "a durable agent harness": conversations, model turns, tool calls and host state
  are committed to storage before anything is shown, and a restarted process picks the work up (DUR, intro). It
  builds on `pi-ai` (model access) and `@earendil-works/chord` (document state) (DUR; NPM).
- Supporting packages: `pi-ai` (providers, models, auth; AI), `pi-mcp` (standalone MCP client, no dependency on other
  pi packages; MCP), `pi-env` (remote `ExecutionEnv` over SSH for Durable; ENV), `pi-schema` (JSON Schema builders for
  tool parameters and signals; DUR "Tools").

For a long-running daemon with Approvals, **Pi Durable is the relevant surface**; the coding-agent SDK is useful only
as a source of `ModelRuntime` (see Auth below).

Runtime requirement: Node `>=22.19.0` (`engines` in the pi-durable `package.json`).

## 1. Durable threads on SQLite and crash recovery

- **Opening.** `Harness.open(storage, { models, registry, ... }, context)` opens a Session over a storage backend;
  `harness.root()` / `harness.createConversation()` return conversations (DUR "Quick Start", "More Conversations").
- **SQLite backend.** `openNodeSqliteStorage(file)` from `@earendil-works/pi-durable/storage/sqlite/node`: one
  database file, WAL with `synchronous = NORMAL`; "commits survive process crashes; the newest may be lost on power or
  host failure". JSONL keeps the whole history in memory, so the README recommends SQLite "for long-running agents".
  Tables can be namespaced with `{ prefix }` to share a database with host tables (DUR "Storage").
- **Concurrency.** "One process writes a storage at a time; there is no cross-process locking." A viewer process opens
  with `readOnly: true`; SQLite file locks keep a reader safe beside the writer (DUR "Storage", "Persist and Resume").
- **Recovery.** Interrupted work stays pending; `harness.resume()` (or any submit/wait) restarts the scheduler.
  Every task saves a checkpoint per step and a phase reruns from its top after a restart (DUR "Concepts", "Sleeping
  and Waking Up").
  - A model request the process died during counts as a failed attempt under `settings.retry`.
  - A tool call reruns after a crash only if declared `replay: "safe"`; otherwise the model gets an `interrupted` error
    result (DUR "Tools").
  - Crash loops are bounded by `settings.restartLimit` (default 5) (DUR "Failures and Recovery").
  - Idempotent input: `submit({ ..., requestId })` returns the existing submission on retry; `harness.submission(id)`
    reacquires one after restart (DUR "Persist and Resume").
- **Failure model.** A storage error ends the Harness (`SessionFailed`); the host watches `harness.closed` and reopens.
  Host code (tasks, tools, hooks) fails only its own unit. Diagnostics go to `onReport(report)` (DUR "Errors",
  "Failures and Recovery").

## 2. Parking a run until an external signal (Approvals)

Pi Durable has first-class support, added in 1.6.0 (DUR-CL 1.6.0 "Added"):

- **Signals.** `defineSignal({ name, version, schema })` defines a typed JSON value; a task sleeps with
  `{ status: "sleeping", signals: [Kind.key(k)], until? }` and holds no process meanwhile. The host delivers with
  `harness.signal(taskId, Kind, key, value, context)`, which returns `delivered | duplicate | invalid | closed |
  not_found`. Early signals are kept; one key serves one wait. **"Nothing checks who sends a signal: authenticate
  senders in your host."** (DUR "Signals").
- **Approval gate.** A `beforeTool` hook may return `{ sleep: { signals, until } }` to park a call *before it runs*.
  Every wake reruns all `beforeTool` hooks, so the gate reads its key with `api.readSignal()` and passes, `block`s, or
  sleeps again; the README's own example is an approval gate keyed by a digest of the arguments, with a memoized
  deadline (DUR "Gates before a tool runs";
  [example 44](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/44-approval-gate.ts)).
  Caveats from the same section: an approval binds to the arguments it saw, so a later hook that rewrites arguments
  can run unapproved arguments; gate side effects must be idempotent; reopening the Harness or changing the registry
  wakes parked gates.
- **Tools that park.** A tool's `execute()` may return `{ sleep: {...} }` or `{ wait: {...} }` and runs again once woken,
  with `cancel()` for cleanup; useful for Connectors that wait on webhooks (DUR "Tools that park").
- **Observing parked work.** The parked call's `pi.live` slot is `sleeping`; `harness.watchTaskGraph()` lists
  sleeping tasks with their signal keys; `harness.wake()` reports `{ active, at }` (DUR "Task Graph", "Sleeping and
  Waking Up").
- **Timers.** Sleep deadlines use the Harness clock (`now`, `setTimer`, overridable for tests); a running scheduler
  keeps a Node process alive while sleeps are pending (DUR "Sleeping and Waking Up").

## 3. Several independent Agents

- **In one Harness:** each conversation stores its own agent in the `pi.agent` document: `model: { provider, modelId }`,
  `thinkingLevel`, selected `extensions`, `tools`, `modelTools`, `instructions`, `cwd`, `maxTurns`, set via
  `conversation.configure()` or at creation (DUR "Per-Conversation Agent";
  [example 27](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/27-reviewer.ts) runs a
  second conversation "with its own model, extensions, tools, directory"). Extensions are stored by name and resolved
  against the process's registry at each use (DUR "Extensions", "Reload").
- **Per-conversation environment:** `HarnessOptions.env(target)` builds an `ExecutionEnv` per call from the
  conversation ID and `cwd`, e.g. a directory or container per conversation (DUR "Environment";
  [example 28](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/28-sandbox-per-conversation.ts)).
  `pi-env` runs tools on another machine over SSH while "the Durable worker, its storage and credentials stay local" (ENV).
- **What is shared within one Harness:** the storage, the registry (installed extension code), `settings`, and the
  single `models: Models | (() => Models)` (DUR-TYPES). So credentials and installed code are per Harness, not per
  conversation.
- **Across Harnesses / processes:** nothing prevents several Harness instances, each on its own storage; the one hard
  rule is one writer per storage (DUR "Storage"). Subagents (task-owned conversations) and child tasks exist for
  delegation inside one Harness (DUR "Abort and Subagents", "Child Tasks").

## 4. Provider, model and auth resolution

- **pi-ai owns auth.** A provider owns its catalog and auth; `Models` routes requests and resolves auth through the
  owning provider: explicit per-request values, then a stored credential from the `CredentialStore`, then environment
  variables or ambient sources (AWS profiles, gcloud ADC). "A stored credential *owns* its provider: environment
  variables are only consulted when nothing is stored." OAuth refresh runs under the store's lock (AI "Auth",
  "Credential Store", "OAuth Providers").
- **Host-supplied store.** `createModels({ credentials: myStore })` injects any `CredentialStore`
  (`read`, `list`, `modify`, `delete`); enumeration "must not resolve secrets" (AI "Credential Store"). Per-request
  `env` scopes provider configuration to one request without leaking ambient variables (AI "Provider-Scoped
  Environment Overrides").
- **Reusing Pi's own config.** The coding agent's `ModelRuntime` "implements Models" and is exported from
  `@earendil-works/pi-coding-agent`; `ModelRuntime.create({ authPath?, modelsPath?, credentials? })` defaults to the
  coding agent's agent-directory files (`auth.json`, `models.json`) (MR; SDK example
  [`09-api-keys-and-oauth.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/09-api-keys-and-oauth.ts);
  CFG `configuration.md`). Since `HarnessOptions.models` takes any pi-ai `Models` (DUR-TYPES), a daemon can pass a
  `ModelRuntime` and inherit whatever the Owner configured with `pi /login`, never reading a key itself. Cost: a
  dependency on the full coding-agent package (TUI included, NPM).
- **Selecting per Agent.** The embedding app stores only `{ provider, modelId }` (plus thinking level) per
  conversation; the Harness resolves it against `models` at request time (DUR "Per-Conversation Agent").
  `models.getAvailable()` / `checkAuth()` list what is configured without exposing secrets (AI "Querying Models",
  "How Auth Resolves").
- **Identity.** `HarnessOptions.identity` controls attribution headers; the default attributes requests to pi;
  `{ attribution: null }` sends none (DUR "Quick Start").

## 5. Custom tools and MCP servers

- **Tools.** `defineTool({ name, description, parameters, execute, replay?, callers?, deferred?, cancel? })`, bundled
  in `defineExtension({ name, tools, sections, hooks, wraps, tasks, namespace? })` and installed with
  `registry.install()`. Each call is its own durable task; arguments are validated against the JSON Schema before
  `execute()`; results carry `output` (model), `structuredOutput` (programs) and `details` (UIs) (DUR "Extensions",
  "Tools"). Hot reload: installing the same extension name replaces it; running calls finish on the old code (DUR
  "Reload").
- **No declarative risk metadata.** Tools have no built-in notion of risk; gating is done in `beforeTool` hooks
  (DUR "Hooks"). Alfred must carry its own Risk level per Tool.
- **MCP in Pi Durable: bring your own bridge.** pi-durable ships no MCP extension (its README mentions MCP only as a
  tool source, e.g. `mcp__github__search` with `callers: ["tools"]`, `deferred: true` + `tool_search` for large MCP
  tool sets, one extension `namespace` per MCP server for code mode) (DUR "Who may call a tool", "Code Mode").
  `pi-mcp` provides `McpClient` with stdio, Streamable HTTP and pipe transports, `toLlmContent()`,
  `createMcpToolName()` (`mcp__<server>__<tool>`), `normalizeMcpInputSchema()`, MCP OAuth with an injectable state
  store, and `validateMcpServerConfig()` for the shared `mcpServers` shape (MCP). Its example wraps MCP tools as
  `pi-agent-core` tools; wrapping them as `defineTool()`s is the analogous host work.
- **The coding-agent SDK** has a ready `createMcpExtension()` reading `mcp.json`, but for `AgentSession`, not for
  Pi Durable (SDK "codemode-mcp"; CFG `mcp.md`).

## 6. API stability

- Pi Durable is past 1.0 by number but **not stable**: the README opens with "**Experimental.** The API changes without
  notice between releases." (DUR line 3).
- Releases are fast and breaking: 0.0.1 on 2026-09-19, 1.0.0 on 2026-10-01, 1.6.0 on 2026-11-20 (NPM); 7 of the 13
  1.x releases have a "Breaking Changes" section (1.0.3, 1.0.4, 1.1.0, 1.2.0, 1.4.0, 1.5.0, 1.6.0) (DUR-CL).
- 1.6.0 examples of churn: tool `execute()` return type widened to allow parks; hook task type renamed; stored task
  formats bumped (`pi.tool` v4, `pi.generation` v3) so "a database written by this version is not meant to be opened by
  an older Harness" (DUR-CL 1.6.0). **Storage format is forward-only**: downgrading after an upgrade is unsafe.
- All `@earendil-works/*` packages release in lockstep at the same version and pin each other exactly (NPM).

## Implications for Alfred

1. **Build on Pi Durable, not the coding-agent SDK.** It already has durable SQLite threads, crash recovery, signals and
   a `beforeTool` approval gate: an Approval maps to a parked tool call keyed by an argument digest, released by
   `harness.signal()` from the PWA's accept/reject.
2. **The daemon must authenticate signal senders** (the PWA/Owner) and map Approval IDs to `(taskId, key)`; Pi does not.
3. **Risk level lives in Alfred.** Wrap each Connector's Tools in an extension; one approvals extension reads Alfred's
   Risk level and gates `write`/`destructive` calls. Order it last among argument-rewriting hooks.
4. **Environment isolation implies one Harness per Agent**, since `models` (credentials), `registry` (code) and
   storage are per Harness. Agents become one Harness each, each on its own SQLite file (or prefix), in one process
   or a process each. In-Harness conversations stay available for threads within one Agent.
5. **Credentials:** either inject a `CredentialStore` backed by each Environment's secret store, or pass a coding-agent
   `ModelRuntime` to reuse the Owner's `pi /login` config. Alfred stores only `{ provider, modelId }` per Agent.
6. **MCP Connectors need a small bridge**: `pi-mcp` client + `defineTool()` per MCP tool, with `deferred`/namespaces for
   large servers. Native Connectors are plain `defineTool()`s.
7. **`AgentRuntime` adapter must hide:** `Harness` open/close/reopen-on-failure, storage choice, `Context`
   plumbing (Chord), `defineTool`/`defineExtension`/`hook` shapes, signal definitions and `harness.signal` result codes,
   task-graph/`pi.live` document shapes for UI state, and model addressing. Pin exact versions and treat every upgrade
   as a migration (back up the SQLite file first).

## Answer

Pi Durable (`@earendil-works/pi-durable`, 1.6.0, MIT) is the embeddable piece: a `Harness` over SQLite
(`openNodeSqliteStorage`) commits every turn, tool call and host document before showing it, resumes interrupted work
on reopen (`resume()`, replay-safe tools, bounded restart loops), and since 1.6.0 can park a tool call before it runs
via a `beforeTool` hook sleeping on a typed signal that the host delivers with `harness.signal()`, which fits Alfred's
Approvals exactly (the host must authenticate senders). Each conversation stores its own model, extensions, tools,
instructions and `cwd`, but storage, installed code and the `Models` collection (credentials) are per Harness, so
isolated Agents should be one Harness each, one writer per storage. Auth resolves inside pi-ai (stored credential, then
env/ambient), so Alfred passes either its own `CredentialStore` or the coding agent's `ModelRuntime` and only stores
`{ provider, modelId }` per Agent. Custom tools are `defineTool()`s in extensions; MCP needs a thin bridge built on
`pi-mcp`. Despite the 1.x number the API is declared experimental and broke in 7 of 13 1.x releases, so Alfred must
pin versions and keep all of it behind its `AgentRuntime` adapter.
