# One Harness per Agent in the daemon, one rootless container per Environment

Each Agent gets its own Pi Durable Harness inside the daemon process, backed by its own SQLite file, so Threads, installed code and storage never mix between Agents. The Agent's Tools and MCP servers run in that Agent's Environment: one rootless container per Agent (Podman on Linux, Podman machine or Docker on WSL 2 for Windows development), reached over stdio through `pi-env`. Connector secrets are mounted into the container as files, and the container gets no network access unless its Connectors need it. Model credentials stay in the daemon and come from the Owner's Pi configuration; each Agent records only which provider and model it uses.

We chose this over a full Durable worker per container (stronger isolation, but Pi Durable ships no transport, so Alfred would have to build one) and over separate OS users (Linux-only and weaker). Node's permission model, worker threads and per-directory `cwd` were rejected because they are not isolation boundaries.

## Consequences

- On a dev PC without containers, an Agent may run its Tools locally, but only on fake data. That setup is not an Environment and must never hold the Owner's real data.
- The launch path (`pi-env` started inside the container) and the cost per container are unverified until the spike in #10.
- Pi Durable storage formats only move forward, so every upgrade backs up each Agent's SQLite file first.
