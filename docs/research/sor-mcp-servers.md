# MCP servers for the Systems of record

Research for [#4](https://github.com/TrentiStefano/Alfred/issues/4). State checked on 2026-11-24 against primary sources: official docs, each server's GitHub repository and source, and the official MCP registry (`registry.modelcontextprotocol.io`). Star counts and dates come from the GitHub API on that day.

**How to read the tables.** Each row is one Tool or a group of Tools that behave the same way. "Proposed Risk level" is our default for the Tool in Alfred (`read`, `write`, `destructive`, as defined in [GLOSSARY.md](../../GLOSSARY.md)). It is a proposal, not something the server declares. Where a server publishes MCP tool annotations (`readOnlyHint` / `destructiveHint`), that is noted, because Alfred could use those hints as a starting point.

**Maturity scale used here:**

- **Official**: shipped by the System of record's own project.
- **Maintained**: a community project with a release in the last 3 months, CI, and a documented release process.
- **Stale**: no commit or release in more than 6 months.

---

## 1. Home Assistant

The official server is the built-in **Model Context Protocol Server** integration (`mcp_server`). It was introduced in Home Assistant 2025.2 ([docs](https://www.home-assistant.io/integrations/mcp_server/)).

| Aspect | Finding | Source |
|---|---|---|
| Maturity | Official. Part of Home Assistant Core. Quality scale `silver`. Pins `mcp==2.3.0`. | [manifest.json](https://github.com/home-assistant/core/blob/dev/homeassistant/components/mcp_server/manifest.json) |
| Transport | Streamable HTTP at `/api/mcp`, plus one endpoint per tool set at `/api/mcp/<API ID>` (for example `/api/mcp/assist`). Legacy SSE is still served at `/mcp_server/sse`. Clients without HTTP support need a stdio proxy. | [http.py docstring](https://github.com/home-assistant/core/blob/dev/homeassistant/components/mcp_server/http.py), [docs](https://www.home-assistant.io/integrations/mcp_server/) |
| Auth | The docs describe OAuth 2.0 with PKCE and no client secret. The views are ordinary `HomeAssistantView`s with `requires_auth = True`, so any valid Home Assistant access token works as a Bearer token, long-lived access tokens included. An option, `require_admin`, rejects non-admin users. | [docs](https://www.home-assistant.io/integrations/mcp_server/), [helpers/http.py](https://github.com/home-assistant/core/blob/dev/homeassistant/helpers/http.py), [http.py](https://github.com/home-assistant/core/blob/dev/homeassistant/components/mcp_server/http.py), [auth API: long-lived tokens](https://developers.home-assistant.io/docs/auth_api/#long-lived-access-token) |
| Scope control | **Device control** (Assist API) only reaches entities exposed to voice assistants. The **Home Assistant** set reaches everything and is admin-only. A **Read-only** option keeps only tools annotated as read-only. Per-set URLs ignore the options and are never read-only. | [docs](https://www.home-assistant.io/integrations/mcp_server/), [server.py](https://github.com/home-assistant/core/blob/dev/homeassistant/components/mcp_server/server.py) |
| Annotations | Yes. Each HA LLM tool's annotations are mapped to MCP `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint`. Undeclared tools default to "not read-only, destructive". | [server.py](https://github.com/home-assistant/core/blob/dev/homeassistant/components/mcp_server/server.py), [helpers/llm.py `ToolAnnotations`](https://github.com/home-assistant/core/blob/dev/homeassistant/helpers/llm.py) |
| Also exposes | One prompt and one read-only resource, `homeassistant://assist/context-snapshot`, with Device control only. No sampling and no notifications. | [docs](https://www.home-assistant.io/integrations/mcp_server/) |
| Disposable dev instance | Yes. The official container image plus the `demo:` integration gives fake entities on many platforms ("The demo entities are dummies"). The MCP server is UI or config-flow only (`config_flow: true`, `single_config_entry`), so a seeded container needs the config-flow REST API scripted once. | [demo integration](https://www.home-assistant.io/integrations/demo/), [manifest.json](https://github.com/home-assistant/core/blob/dev/homeassistant/components/mcp_server/manifest.json) |

### Tools

| Tool | Set | What it does | Server hint | Proposed Risk level |
|---|---|---|---|---|
| `homeassistant__GetLiveContext` | Device control | Current state of exposed entities | read-only | `read` |
| `intent__HassTurnOn`, `intent__HassTurnOff` (also lock/unlock and open/close covers) | Device control | Switch entities | not read-only | `write`; **`destructive` when the target is a lock, alarm or garage door** (see note) |
| `intent__HassSetPosition`, `intent__HassStopMoving` | Device control | Covers and valves | not read-only | `write` |
| Timer intents: `HassStartTimer`, `HassCancelTimer`, `HassCancelAllTimers`, `HassIncreaseTimer`, `HassDecreaseTimer`, `HassPauseTimer`, `HassUnpauseTimer` | Device control | Device timers | not read-only | `write` |
| `HassTimerStatus` | Device control | Timer status | read-only | `read` |
| `llm__GetDateTime` | both | Current date and time | n/a | `read` |
| `homeassistant__render_template` | Home Assistant (admin) | Render a Jinja template (states, attributes) | read-only, idempotent | `read` |
| `homeassistant__search_actions` | Home Assistant | List callable actions and their fields | read-only | `read` |
| `homeassistant__call_action` | Home Assistant | Run **any** action on any entity, device or area | changes state | `destructive` by default; Alfred should narrow it per action domain |
| `config__get_config_entries`, `config__search_integrations`, `search__search` | Home Assistant | Integrations and entity search | read-only | `read` |
| `config__reload_config_entry` | Home Assistant | Reload an integration | changes state | `write` |
| `system_health__get_system_info`, `history__get_history`, `system_log__get_entries`, `system_log__get_logs` / `hassio__get_logs` | Home Assistant | System info, statistics, logs (credential-like values masked, but not all secrets) | read-only | `read` (logs: treat output as sensitive) |

Sources: the tool list is from the [LLM integration docs](https://www.home-assistant.io/integrations/llm/#list-of-home-assistant-ai-tools). Intent names and annotations are from [components/intent/llm.py](https://github.com/home-assistant/core/blob/dev/homeassistant/components/intent/llm.py). `GetLiveContext` is in [components/homeassistant/llm.py](https://github.com/home-assistant/core/blob/dev/homeassistant/components/homeassistant/llm.py).

Note: `HassTurnOn`/`HassTurnOff` are generic. The source tells the model to use them to lock and unlock locks ([intent/llm.py](https://github.com/home-assistant/core/blob/dev/homeassistant/components/intent/llm.py)). One Tool name can therefore carry different consequences, and a static per-Tool Risk level is not enough. Alfred would need to derive the risk from the arguments (the target entity's domain), or expose only safe domains to voice assistants.

---

## 2. Firefly III

No official MCP server exists. Searching `firefly-iii/*` turns up nothing, and the registry has only a community entry, `io.github.YakupEmreYerli/mcp-firefly-iii`. The registry was queried with `?search=firefly`. Two candidates matter:

| Aspect | `daften/fireflyiii-mcp` | `etnperlong/firefly-iii-mcp` |
|---|---|---|
| Maturity | **Maintained.** 30 stars, MIT, TypeScript. v1.0.0 on 2026-11-08, v1.0.1 on 2026-11-13, nightly builds, CI. Requires Firefly III ≥ 6.4.0. ([repo](https://github.com/daften/fireflyiii-mcp), [releases](https://github.com/daften/fireflyiii-mcp/releases)) | **Stale.** 90 stars, MIT. Last commit and release v1.4.0 on 2025-06-12, about 17 months ago. ([repo](https://github.com/etnperlong/firefly-iii-mcp), [releases](https://github.com/etnperlong/firefly-iii-mcp/releases)) |
| Transport | stdio (npm), Streamable HTTP (npm or Docker image `ghcr.io/daften/fireflyiii-mcp`) ([README](https://github.com/daften/fireflyiii-mcp#readme)) | stdio (`@firefly-iii-mcp/local`), Streamable HTTP + SSE (`@firefly-iii-mcp/server`), Cloudflare Worker ([README](https://github.com/etnperlong/firefly-iii-mcp#readme)) |
| Auth to Firefly | Personal Access Token (`FIREFLY_URL`, `FIREFLY_TOKEN`). The HTTP mode also supports OAuth. ([README](https://github.com/daften/fireflyiii-mcp#readme), [HTTP/PAT guide](https://daften.github.io/fireflyiii-mcp/guide/http-pat)) | PAT via env, or per-request `Authorization` + `X-Firefly-III-Url` headers, or query parameters (discouraged by the README itself) ([README](https://github.com/etnperlong/firefly-iii-mcp#readme)) |
| Scope control | Presets and groups (`MCP_PRESET`, `MCP_GROUPS`). **`MCP_READ_ONLY=true` removes every create, update, delete, trigger and upload tool.** ([filtering](https://daften.github.io/fireflyiii-mcp/reference/filtering)) | Presets and tags (`FIREFLY_III_PRESET`, `FIREFLY_III_TOOLS`). No read-only switch documented. Tools are generated from the OpenAPI spec. ([README](https://github.com/etnperlong/firefly-iii-mcp#readme)) |
| Annotations | None documented ([tool reference](https://daften.github.io/fireflyiii-mcp/reference/tools)) | None documented |
| Disposable dev instance | Yes. Official `fireflyiii/core` image plus MariaDB from the official compose file ([firefly-iii/docker](https://github.com/firefly-iii/docker/blob/main/docker-compose.yml)). Fake data must be seeded through the API, since there is no demo seed. The repo has `npm run test:integration` against a live instance. ([README](https://github.com/daften/fireflyiii-mcp#readme)) | Same Firefly container, but the server is stale |

### Tools (`daften/fireflyiii-mcp`, 137 tools in 14 groups)

| Tools | Proposed Risk level |
|---|---|
| All `get_*`, `search_*`, `get_insight_*`, chart and summary tools, `get_about`, `get_exchange_rate`, `download_attachment`, `export_*` (9 export tools) | `read` (exports are bulk reads of financial data: flag as sensitive output) |
| `test_rule`, `test_rule_group` (dry runs; "make no changes") | `read` |
| `create_*` (accounts, transactions, split transactions, budgets, budget limits, categories, bills, piggy banks, recurring, rules, rule groups, tags, currencies, attachments, transaction links), `upload_attachment` | `write` |
| `update_*` on single objects, `enable_currency`, `disable_currency` | `write` |
| `bulk_update_transactions`, `set_primary_currency`, `trigger_rule`, `trigger_rule_group`, `trigger_recurrence` (apply rules or recurrences to many existing transactions) | `destructive` (wide, hard to reverse) |
| All 15 `delete_*` (the docs say "This action cannot be undone"; `delete_rule_group` also removes its rules, `delete_attachment` also removes file data) | `destructive` |

Source: [tool reference](https://daften.github.io/fireflyiii-mcp/reference/tools).

---

## 3. Paperless-ngx

No official server exists. Two community servers are actively maintained:

| Aspect | `baruchiro/paperless-mcp` | `barryw/PaperlessMCP` |
|---|---|---|
| Maturity | **Maintained.** 152 stars, ISC, TypeScript. v2.3.0 on 2026-11-14, last push 2026-11-20. Actively developed successor of `nloui/paperless-mcp` (254 stars, last push 2025-11-11, no releases). ([repo](https://github.com/baruchiro/paperless-mcp), [releases](https://github.com/baruchiro/paperless-mcp/releases), [nloui repo](https://github.com/nloui/paperless-mcp)) | **Maintained.** 58 stars, MIT, C#/.NET. v0.7.0 on 2026-11-02. ([repo](https://github.com/barryw/PaperlessMCP), [releases](https://github.com/barryw/PaperlessMCP/releases)) |
| Transport | stdio (default, `npx @baruchiro/paperless-mcp`). Streamable HTTP with `--http` at `POST /mcp` (stateless). The Docker image runs HTTP and SSE. ([README](https://github.com/baruchiro/paperless-mcp#readme)) | Streamable HTTP on `:5000/mcp` (default), stdio with `--stdio`. Docker and Kubernetes manifests. ([README](https://github.com/barryw/PaperlessMCP#readme)) |
| Auth | Paperless API token (`PAPERLESS_URL`, `PAPERLESS_API_KEY`). In HTTP mode, since v2.0.0, each request must send `Authorization: Bearer <paperless-token>`, which is passed through so Paperless permissions apply. `--no-auth` falls back to the server token. ([README](https://github.com/baruchiro/paperless-mcp#readme)) | `PAPERLESS_API_TOKEN` on the server. **No inbound auth on `/mcp`** unless you add a proxy in front. ([README](https://github.com/barryw/PaperlessMCP#readme)) |
| Safety features | None built in (no read-only mode documented) | Destructive operations require `confirm=true`. Bulk operations default to dry-run. ([README](https://github.com/barryw/PaperlessMCP#readme)) |
| Disposable dev instance | **Yes, out of the box.** `docker-compose.e2e.yml` boots an empty Paperless-ngx with `admin/admin123`. The E2E suite uploads a PDF and runs list, search, download and bulk-edit through MCP. Runs in CI on every PR. ([README: E2E tests](https://github.com/baruchiro/paperless-mcp#e2e-tests)) | Yes (the same Paperless container); no seeded e2e harness documented |

### Tools (`baruchiro/paperless-mcp`)

| Tools | Proposed Risk level |
|---|---|
| `list_documents`, `query_documents`, `get_document`, `search_documents`, `download_document`, `get_document_thumbnail`, `list_document_notes`, `list_tags`, `list_storage_paths`, `list_tasks`, `list_correspondents`, `list_document_types`, `list_custom_fields`, `get_custom_field`, `list_mail_accounts`, `get_mail_account` (secrets redacted), `list_mail_rules`, `get_mail_rule` | `read` |
| `post_document` (upload), `create_document_note`, `create_tag`, `create_correspondent`, `create_document_type`, `create_custom_field`, `update_custom_field`, `acknowledge_tasks`, `create_mail_rule`, `update_mail_rule` | `write` |
| `process_mail_account` (triggers ingestion now) | `write` |
| `bulk_edit_documents` with metadata methods (`set_correspondent`, `set_document_type`, `set_storage_path`, `add_tag`, `remove_tag`, `modify_tags`, `reprocess`, `rotate`) | `write` |
| `bulk_edit_documents` with `delete`, `merge`/`split` (with `delete_originals`), `delete_pages`, `set_permissions` | `destructive` |
| `delete_document_note`, `delete_custom_field`, `bulk_edit_custom_fields` (`delete`), `delete_mail_rule` | `destructive` |

Source: [README: Available Tools](https://github.com/baruchiro/paperless-mcp#available-tools).

As with Home Assistant, `bulk_edit_documents` is one Tool whose risk depends on its `method` argument. Deleted documents go to the Paperless trash and stay restorable for `PAPERLESS_EMPTY_TRASH_DELAY` days, 30 by default ([configuration.md](https://github.com/paperless-ngx/paperless-ngx/blob/dev/docs/configuration.md#PAPERLESS_EMPTY_TRASH_DELAY), [usage.md: Move to Trash](https://github.com/paperless-ngx/paperless-ngx/blob/dev/docs/usage.md)). Deleting pages, merging with `delete_originals`, and splitting are not covered by the trash, so `destructive` stays the right default for them.

`barryw/PaperlessMCP` has 43 tools with full CRUD on documents, tags, correspondents, document types, storage paths and custom fields, plus `*_bulk_delete` ([README: The Full Toolbox](https://github.com/barryw/PaperlessMCP#the-full-toolbox)). The mapping is the same: `*_list`/`*_get`/`*_download`/`*_preview`/`ping` → `read`, `*_create`/`*_update`/`upload*`/`reprocess`/`custom_fields_assign` → `write`, `*_delete`/`*_bulk_delete`/`documents_bulk_update` → `destructive`.

---

## 4. CalDAV / Radicale

No official server exists from Radicale. Kozea/Radicale has no MCP component ([repo](https://github.com/Kozea/Radicale)). Two maintained community servers are listed in the MCP registry:

| Aspect | `langmail/caldav-mcp` (formerly `dominik1001/caldav-mcp`) | `PhilflowIO/dav-mcp` |
|---|---|---|
| Maturity | **Maintained.** 115 stars, MIT, TypeScript. v0.12.1 on 2026-11-23. Registry: `io.github.langmail/caldav-mcp`. ([repo](https://github.com/langmail/caldav-mcp), [releases](https://github.com/langmail/caldav-mcp/releases)) | **Maintained.** 47 stars, MIT, JavaScript. v5.1.2 on 2026-11-18. Registry: `io.github.PhilflowIO/dav-mcp`. ([repo](https://github.com/PhilflowIO/dav-mcp), [releases](https://github.com/PhilflowIO/dav-mcp/releases)) |
| Transport | stdio (default). Streamable HTTP with `--http`, stateless, `POST /mcp`, `GET /health`. Docker image on GHCR. ([README: Transports](https://github.com/langmail/caldav-mcp#transports)) | stdio. HTTP mode (n8n-style) and Docker. ([README](https://github.com/PhilflowIO/dav-mcp#readme)) |
| Auth | To CalDAV: `CALDAV_BASE_URL`, `CALDAV_USERNAME`, `CALDAV_PASSWORD`. Inbound HTTP: `MCP_AUTH_TOKEN` Bearer, required when not bound to loopback. One process serves one account. Origin header rejected, Host checked on loopback. ([README](https://github.com/langmail/caldav-mcp#transports)) | To CalDAV: Basic or Digest (`AUTH_METHOD`), with separate CardDAV credentials possible. Inbound HTTP: `BEARER_TOKEN` of at least 32 characters is required. Rate limiting. ([README: Authentication, Security](https://github.com/PhilflowIO/dav-mcp#authentication)) |
| Radicale | Cites Radicale (with the email hook) for scheduling ([README](https://github.com/langmail/caldav-mcp#create-event)) | Listed as "Full support" ([README](https://github.com/PhilflowIO/dav-mcp#works-across-all-major-providers)) |
| Disposable dev instance | **Yes.** Radicale publishes official images (`kozea/radicale` on Docker Hub and GHCR) ([DOCUMENTATION.md: Docker](https://github.com/Kozea/Radicale/blob/master/DOCUMENTATION.md#docker)). Auth `none` "allows all usernames and passwords", which suits fake data ([v3 docs](https://radicale.org/v3.html)). Seeding means PUTting `.ics` files. | Same |

### Tools (`langmail/caldav-mcp`)

| Tool | Proposed Risk level |
|---|---|
| `list-calendars`, `list-events`, `list-todos` | `read` |
| `create-event`, `create-todo`, `complete-todo` | `write`; **`create-event` with `attendees` + `organizer` sends invitations on a scheduling-capable server**, so it becomes an outbound message |
| `update-event` | `write`. The README warns that updating an event with attendees "rewrites them as bare addresses, dropping their names and replies". Consider `destructive` when attendees exist. |
| `update-todo` | `write` |
| `delete-event`, `delete-todo` | `destructive` (CalDAV has no trash; Radicale only keeps history if you set up its [Git versioning hook](https://github.com/Kozea/Radicale/blob/master/DOCUMENTATION.md#versioning-collections-with-git)) |

Source: [README: Available Tools](https://github.com/langmail/caldav-mcp#available-tools).

### Tools (`PhilflowIO/dav-mcp`, 27 tools)

| Tools | Proposed Risk level |
|---|---|
| `list_calendars`, `list_events`, `calendar_query`, `calendar_multi_get`, `freebusy_query`, `list_addressbooks`, `list_contacts`, `addressbook_query`, `addressbook_multi_get`, `list_todos`, `todo_query`, `todo_multi_get` | `read` |
| `create_event`, `update_event`, `make_calendar`, `update_calendar`, `create_contact`, `update_contact`, `create_todo`, `update_todo` | `write` |
| `update_event_raw`, `update_contact_raw`, `update_todo_raw` (replace the whole iCal/vCard) | `destructive` |
| `delete_event`, `delete_contact`, `delete_todo` ("permanently"), `delete_calendar` ("and all its events") | `destructive` |

Source: [README: Available Tools](https://github.com/PhilflowIO/dav-mcp#available-tools-27-total).

---

## 5. SearXNG

No official server exists from the SearXNG project. One community server dominates:

| Aspect | `ihor-sokoliuk/mcp-searxng` |
|---|---|
| Maturity | **Maintained, the most adopted server in this survey.** 1,382 stars, MIT, TypeScript. v2.11.0 on 2026-11-17, last push 2026-11-23. Registry: `io.github.ihor-sokoliuk/mcp-searxng`. ([repo](https://github.com/ihor-sokoliuk/mcp-searxng), [releases](https://github.com/ihor-sokoliuk/mcp-searxng/releases)) |
| Transport | stdio (default). Streamable HTTP when `MCP_HTTP_PORT` is set (stateful legacy sessions, or stateless). Docker compose (stdio-only by default). ([README](https://github.com/ihor-sokoliuk/mcp-searxng#how-it-works)) |
| Auth | To SearXNG: none, or HTTP Basic through URL userinfo or `AUTH_USERNAME`/`AUTH_PASSWORD`. Inbound HTTP: static bearer `MCP_HTTP_AUTH_TOKEN` in hardened mode, or OAuth (JWKS, issuer, audience, scopes). ([CONFIGURATION.md](https://github.com/ihor-sokoliuk/mcp-searxng/blob/main/CONFIGURATION.md)) |
| Network safety | `web_url_read` blocks private and internal addresses by default, including DNS-rebinding and redirect-to-private cases. `MCP_HTTP_ALLOW_PRIVATE_URLS=true` opts out. ([CONFIGURATION.md](https://github.com/ihor-sokoliuk/mcp-searxng/blob/main/CONFIGURATION.md)) |
| Disposable dev instance | **Yes.** Official SearXNG container files ([searxng/container](https://github.com/searxng/searxng/tree/master/container)). The JSON API must be enabled: the default `search.formats` is only `html` ([settings.yml](https://github.com/searxng/searxng/blob/master/searx/settings.yml)), and an unset format returns 403 ([search API docs](https://docs.searxng.org/dev/search_api.html)). There is nothing to seed, but results depend on live upstream engines, so they are not deterministic. |

### Tools

| Tool | What it does | Proposed Risk level |
|---|---|---|
| `searxng_web_search` | Search through SearXNG | `read` |
| `searxng_search_suggestions` | Query completion | `read` |
| `searxng_instance_info` | Categories, engines, defaults | `read` |
| `web_url_read` | Fetch a URL and return Markdown | `read`, but it is an **egress** Tool: a fetched page is untrusted content (prompt injection), and the URL itself can leak data. Keep the private-URL block on. |

Source: [README: Tools](https://github.com/ihor-sokoliuk/mcp-searxng#tools).

---

## Implications for Alfred

1. **Every planned System of record has a usable MCP server.** Home Assistant's is official. The other four are community-maintained and had releases in November 2026. Firefly III is the weakest: the best-known server (`etnperlong`) is stale, and the maintained one (`daften`) has only been at 1.0 since 2026-11-08.
2. **Config-only MCP Connectors (no native code) are realistic for:**
   - **SearXNG**: `ihor-sokoliuk/mcp-searxng`. All Tools are `read`, it is mature, and SSRF protection is on by default. This is the strongest case for dropping a planned native Connector.
   - **Home Assistant**: the official `mcp_server` over Streamable HTTP with a long-lived token, preferably through the **Device control** set, where the Owner decides what is exposed. Alfred should not enable the admin-only **Home Assistant** set with `call_action` by default.
   - **CalDAV/Radicale**: `langmail/caldav-mcp`, which has a small Tool surface, bearer-protected HTTP and an official Radicale image for development.
   - **Paperless-ngx**: `baruchiro/paperless-mcp`, which has per-request token pass-through and a ready Docker e2e harness.
   - **Firefly III**: `daften/fireflyiii-mcp`, possible with `MCP_READ_ONLY=true` as the starting point. Write Tools should only be enabled after the server has a longer release history.
3. **The Risk level cannot always be a static per-Tool value.** `HassTurnOn`/`HassTurnOff` (locks), Home Assistant `call_action`, Paperless `bulk_edit_documents` (`method`), and CalDAV `create-event` (invitations) all change consequence with their arguments. Alfred's Connector config needs either (a) argument-aware Risk rules, or (b) a "most dangerous case" default (`destructive`) with Owner-approved downgrades. Either way, this is the one place where "config-only" MCP still needs some Alfred-side logic. It is generic logic, not per-System native code.
4. **MCP tool annotations help but cannot be trusted alone.** Only Home Assistant emits `readOnlyHint`/`destructiveHint`. None of the community servers document annotations. Alfred should own the Risk level mapping in its Connector config, seeded from annotations where present, and default unknown Tools to `destructive`.
5. **Transport:** every server here supports Streamable HTTP, and all but Home Assistant also support stdio. Alfred can standardise on Streamable HTTP, with each MCP server as its own container inside the Agent's Environment. That keeps credentials such as the Paperless token, the Firefly PAT and CalDAV passwords in the server's environment, not in Alfred's process. `barryw/PaperlessMCP` has no inbound auth, so it should only run on a private network.
6. **Development with fake data is possible for all five**, and each System of record ships an official container image. Paperless (`baruchiro` e2e compose) and Home Assistant (`demo:`) give fake data almost for free. Firefly and Radicale need a small seeding script. SearXNG needs JSON enabled and cannot give deterministic results.
7. **Supply chain.** All non-HA servers are single-maintainer community projects. Alfred should pin versions (npm version or image digest) and review upgrades, since each server holds a credential to a System of record.

## Answer

All five Systems of record can be reached through existing MCP servers today, so no native Connector is strictly required. Home Assistant ships an official MCP server in Core: Streamable HTTP plus legacy SSE, OAuth or any HA access token, a read-only switch, and real `readOnlyHint`/`destructiveHint` annotations. The others have maintained community servers that all speak stdio and Streamable HTTP with token auth: `ihor-sokoliuk/mcp-searxng` for SearXNG (mature, all `read`), `langmail/caldav-mcp` or `PhilflowIO/dav-mcp` for CalDAV/Radicale, `baruchiro/paperless-mcp` for Paperless-ngx, and `daften/fireflyiii-mcp` for Firefly III (new but active, with a read-only mode; the better-known `etnperlong/firefly-iii-mcp` has been stale since June 2025). Every server can run against a disposable official container with fake data: Paperless and Home Assistant almost for free, Firefly and Radicale with a small seed script, and SearXNG with JSON enabled but non-deterministic results. So Connectors can be config-only MCP. The native code Alfred still needs is generic: an argument-aware Risk level mapping, because several Tools (HA `HassTurnOn` on locks and `call_action`, Paperless `bulk_edit_documents`, CalDAV `create-event` with attendees) change consequence depending on their arguments.
