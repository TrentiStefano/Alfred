# Flutter client for Desktop and iPhone Web PWA

Alfred's UI is a single Flutter codebase (`apps/client`) targeting both a full desktop app and the iPhone Home Screen Web PWA, replacing the Phase 0 TypeScript `apps/pwa` placeholder when Slice 1 is implemented. The daemon and `@alfred/protocol` stay TypeScript/Node; `@alfred/protocol` (Zod) remains the single source of truth for the wire contract, and Dart models in `apps/client` are verified against shared JSON fixtures or exported schemas.

We chose this over a TypeScript PWA (either used only as a browser/installed PWA, or wrapped in Electron/Tauri) and over maintaining separate TypeScript mobile and Flutter desktop apps. The Owner wants a native-feeling desktop app alongside the iPhone PWA, has already proven this Flutter pairing in PiFrame (desktop works great and Flutter Web's startup/quirks on iPhone are acceptable), and avoids both Chromium/Rust wrapper trade-offs and maintaining two UI codebases.

## Consequences

- `apps/client` lives outside `pnpm-workspace.yaml` as a Flutter/Dart package; Slice 1 updates `AGENTS.md`, `.dependency-cruiser.cjs`, `scripts/verify.ts`, and CI to replace `apps/pwa` and run `flutter analyze` and `flutter test` inside `pnpm verify`.
- iOS Home Screen Web Push still uses a thin `web/` browser shell (Declarative Web Push or service worker, `getSubscription()` on launch, `navigate` deep links) alongside the Flutter Web app.
- PiFrame's Flutter client, daemon-side device pairing, and Tailscale setup are used only as reference examples, not dependencies.
