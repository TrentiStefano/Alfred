# Slice 2 SearXNG Environment image

Build the image before starting Alfred. Run these commands from the repository root with a rootless Podman connection selected.

```sh
podman info --format '{{.Host.Security.Rootless}}'
podman build --timestamp=0 --tag localhost/alfred-searxng:slice-2 apps/daemon/environment/searxng
podman image inspect localhost/alfred-searxng:slice-2 --format '{{.Id}}'
```

The first command must print `true`. In the Owner’s local configuration, set `ALFRED_SEARXNG_ENABLED=true` and set `ALFRED_SEARXNG_IMAGE=sha256:<id>` to the full image ID returned by the last command. Include the `sha256:` prefix once. The tag is a build label. Alfred runs the local image by its immutable ID with pulling disabled.

The image runs a synthetic SearXNG endpoint on container loopback. Alfred starts it with the network disabled and invokes the MCP server over private stdio. The synthetic endpoint returns fixed data and has no upstream search engines.

On restart, Alfred checks that an existing labeled container still uses the configured pinned image and has network mode `none`. If the pin changes, retire the previous local Environment container or choose a new container name before enabling the new pin.

The deterministic Thread test runs in required CI. To also run the real rootless Podman path, set `ALFRED_SEARXNG_PODMAN=1`, `ALFRED_SEARXNG_IMAGE=sha256:<id>`, and any needed `ALFRED_PODMAN_PATH` / `ALFRED_PODMAN_CONNECTION`, then run:

```sh
pnpm exec vitest run apps/daemon/tests/pi-durable-runtime.test.ts -t "pinned rootless Podman image"
```

## Pin review and rollback

- The initial pin is [mcp-searxng v2.11.0](https://github.com/ihor-sokoliuk/mcp-searxng/tree/8b05e79e6e5e935582acbc13e8b34087add0adbb), paired with pi-env 1.6.1 from the Environment spike. The npm lock records integrity hashes for the server and its dependencies. The Containerfile records the base image digest. The npm registry advertises provenance for the selected MCP release. The initial smoke check returned a fixed search result from the real MCP package over stdio with rootless Podman networking disabled.
- Review updates against the current pins. Check artifact provenance, upstream and dependency changes, and changes in Tools, credentials, and network access. Run the affected synthetic Connector checks and keep the previous reviewed image ID available locally so an Owner can restore it if it is still safe.
- This is the first pin. Its rollback is to disable the Connector. If a deployed release is unsafe, disable the Connector until a safe pin is available.
