# Manual Dev Smoke Check (Real Pi Provider — Opt-in)

Use this checklist to verify Slice 1 ("Talk to Alfred") end-to-end against your real Pi provider configuration (outside CI) without committing any secrets or personal configuration.

> **Public-repo rule:** Never commit `auth.json`, `.env`, `apps/daemon/agents/main.local.md`, or `data/` files. All `*.local.*` and `data/` paths are gitignored and enforced by `pnpm check:repo`.

## Prerequisites

1. Node `>=24`, `pnpm`, and Flutter `3.47+` installed.
2. Workspace dependencies installed:
   ```sh
   pnpm install
   cd apps/client && flutter pub get && cd ../..
   ```
3. Your Pi credentials already configured locally (e.g., `~/.pi/agent/auth.json` via Pi CLI login / API key setup). `ModelRuntime.create()` reads Pi's existing `auth.json` and `models.json` automatically.

## 1. Configure your local Main Agent (gitignored)

Copy the committed template to a gitignored local override:

```sh
cp apps/daemon/agents/main.example.md apps/daemon/agents/main.local.md
```

Edit `apps/daemon/agents/main.local.md` to select your Haiku 5.5 model from Pi (the committed example uses `anthropic/claude-haiku-5-5`; use the exact id your Pi model catalog lists) and any personal system instructions.

## 2. Start the Alfred daemon

```sh
pnpm --filter @alfred/daemon start
```

Optional environment variables:

- `ALFRED_DAEMON_HOST` (default `127.0.0.1`)
- `ALFRED_DAEMON_PORT` (default `4040`)
- `ALFRED_DATA_DIR` (default `apps/daemon/data`, gitignored)
- `ALFRED_MAIN_AGENT_PATH` (optional explicit path instead of `apps/daemon/agents/main.local.md`)

Verify `/health` responds:

```sh
curl http://127.0.0.1:4040/health
```

Expected: `{"ok":true,"service":"alfred-daemon","protocolVersion":1}`.

## 3. Connect a Flutter client

### Option A — Web client

```sh
cd apps/client
flutter run -d chrome --web-browser-flag="--disable-web-security"
```

Or serve a release build (`flutter build web`) over local HTTP and open:

```
http://127.0.0.1:<web-port>/?daemonUrl=http%3A%2F%2F127.0.0.1%3A4040
```

### Option B — Desktop client

Run directly with Flutter or run the compiled binary (`flutter build windows` / `linux` / `macos`):

```sh
ALFRED_DAEMON_URL=http://127.0.0.1:4040 flutter run -d windows
```

## 4. Verify live streaming and SQLite persistence

1. Confirm the status chip shows `Connected`.
2. Send a prompt and watch the status chip transition `Streaming` → `Connected` as incremental deltas arrive.
3. Stop the daemon (`Ctrl+C`) and restart `pnpm --filter @alfred/daemon start`.
4. Reopen or refresh the client and confirm the previous Thread messages reload from SQLite with zero duplicates.
5. Run `pnpm check:repo` to verify no local files or secrets are tracked by git.
