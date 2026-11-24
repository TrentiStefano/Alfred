# Research: how each Agent gets an exclusive Environment

Ticket: [#5](https://github.com/TrentiStefano/Alfred/issues/5). Researched 2026-11-24.

Question: what are the realistic ways to give each **Agent** an exclusive **Environment** (its own secrets, data and
filesystem) on one host that is Windows during development and Linux later; how the Alfred daemon talks to an Agent
across that boundary; how secrets reach an Environment without landing in daemon logs or the LLM context; and what it
costs on a small always-on machine.

Pi sources are read at commit
[`f8149d1`](https://github.com/earendil-works/pi/tree/f8149d1abde50b31c8cb5aed09e89319b927f247) of
`earendil-works/pi` (npm `@earendil-works/pi-durable`, `@earendil-works/pi-env`, `@earendil-works/pi-mcp`,
`@earendil-works/pi-coding-agent`, all 1.6.0). Links below abbreviate that tree as **[pi]**.

## Sources

- [D-readme] Pi Durable README, [pi]/packages/durable/README.md — <https://github.com/earendil-works/pi/blob/f8149d1abde50b31c8cb5aed09e89319b927f247/packages/durable/README.md>
- [D-node] Durable `NodeExecutionEnv` source, [pi]/packages/durable/src/env/node.ts — <https://github.com/earendil-works/pi/blob/f8149d1abde50b31c8cb5aed09e89319b927f247/packages/durable/src/env/node.ts>
- [D-ex28] Durable example "sandbox per conversation" — <https://github.com/earendil-works/pi/blob/f8149d1abde50b31c8cb5aed09e89319b927f247/packages/durable/test/examples/28-sandbox-per-conversation.ts>
- [E-readme] pi-env README — <https://github.com/earendil-works/pi/blob/f8149d1abde50b31c8cb5aed09e89319b927f247/packages/env/README.md>
- [E-proto] pi-env wire protocol — <https://github.com/earendil-works/pi/blob/f8149d1abde50b31c8cb5aed09e89319b927f247/packages/env/docs/protocol.md>
- [E-sem] pi-env semantics — <https://github.com/earendil-works/pi/blob/f8149d1abde50b31c8cb5aed09e89319b927f247/packages/env/docs/semantics.md>
- [E-conn] pi-env `Connection` source — <https://github.com/earendil-works/pi/blob/f8149d1abde50b31c8cb5aed09e89319b927f247/packages/env/src/connection.ts>
- [M-readme] pi-mcp README — <https://github.com/earendil-works/pi/blob/f8149d1abde50b31c8cb5aed09e89319b927f247/packages/mcp/README.md>
- [C-sec] Pi coding agent, "Run Pi safely" — <https://github.com/earendil-works/pi/blob/f8149d1abde50b31c8cb5aed09e89319b927f247/packages/coding-agent/docs/security.md>
- [C-cont] Pi coding agent, "Run Pi in an isolated environment" — <https://github.com/earendil-works/pi/blob/f8149d1abde50b31c8cb5aed09e89319b927f247/packages/coding-agent/docs/containerization.md>
- [C-rpc] Pi coding agent, RPC mode — <https://github.com/earendil-works/pi/blob/f8149d1abde50b31c8cb5aed09e89319b927f247/packages/coding-agent/docs/rpc.md>
- [N-perm] Node.js docs, Permissions — <https://nodejs.org/api/permissions.html>
- [N-worker] Node.js docs, Worker threads — <https://nodejs.org/api/worker_threads.html>
- [N-cp] Node.js docs, Child process — <https://nodejs.org/api/child_process.html>
- [N-proc] Node.js docs, Process (`process.setuid`) — <https://nodejs.org/api/process.html>
- [N-net] Node.js docs, Net ("Identifying paths for IPC connections", `server.listen` options) — <https://nodejs.org/api/net.html>
- [DK-rootless] Docker docs, Rootless mode — <https://docs.docker.com/engine/security/rootless/>
- [DK-win] Docker docs, Install Docker Desktop on Windows — <https://docs.docker.com/desktop/setup/install/windows-install/>
- [DK-secrets] Docker docs, Secrets in Compose — <https://docs.docker.com/compose/how-tos/use-secrets/>
- [P-podman] Podman docs, `podman(1)` — <https://docs.podman.io/en/latest/markdown/podman.1.html>
- [P-run] Podman docs, `podman-run(1)` — <https://docs.podman.io/en/latest/markdown/podman-run.1.html>
- [P-secret] Podman docs, `podman-secret-create(1)` — <https://docs.podman.io/en/latest/markdown/podman-secret-create.1.html>
- [P-machine] Podman docs, `podman-machine(1)` and `podman-machine-init(1)` — <https://docs.podman.io/en/latest/markdown/podman-machine.1.html>, <https://docs.podman.io/en/latest/markdown/podman-machine-init.1.html>
- [WSL] Microsoft Learn, Advanced settings configuration in WSL — <https://learn.microsoft.com/en-us/windows/wsl/wsl-config>

## What Pi and Pi Durable already give us

**Pi has no built-in sandbox.** Pi's own security page says it reads, changes and executes files "with the
permissions of the account that started it", that safety comes from an operating-system or virtualization boundary,
and lists "lack of a built-in sandbox" as outside its security boundary [C-sec]. It ranks running "entirely inside a
container, virtual machine, or sandbox" as "usually the strongest practical option" [C-sec]. Its containerization page
compares plain Docker, Docker Sandboxes, NVIDIA OpenShell and the Gondolin micro-VM extension; it warns that
environment variables passed into a container are visible to every process inside it, and that Gondolin's VM
"inherit[s] the host process environment" so it is not a credential boundary [C-cont].

**Durable separates "where the harness runs" from "where tools run".** A Harness takes an `env` function that builds
the `ExecutionEnv` for every tool call; it receives the conversation ID and committed reads, "so one function serves a
directory per conversation or a container per conversation", and a custom `ExecutionEnv` sets an `id`, "for example one
id per container" [D-readme]. The built-in `read`/`write`/`edit`/`bash` tools touch files and processes only through
that environment [D-readme]. Example 28 records a sandbox per conversation in an app document and notes that "a hosted
product would return an ExecutionEnv that runs inside the conversation's container" [D-ex28].

**pi-env is the cross-boundary transport Durable ships.** `@earendil-works/pi-env` provides `RemoteExecutionEnv`, a
Durable `ExecutionEnv` whose operations run in a small Rust daemon (`pi-env`) "while the Durable worker, its storage and
credentials stay local" [E-readme]. The protocol is length-prefixed frames over the daemon process's **stdin/stdout**;
stderr "is diagnostic text for logs only" [E-proto]. The client's `Connection` takes an arbitrary argv `command` and
appends `serve --token <hex>` [E-conn]; the docs show `ssh` and a local binary (`localDaemon()`) as commands [E-readme].
The daemon ships for Linux, macOS, Android and Windows on x86-64 and arm64 [E-readme]. It kills every process group it
started when stdin ends or after 30 s without bytes; on Windows a terminated daemon "cannot clean up" grandchildren
except for `process` programs, which get their own job object [E-proto]. `openProcess()` runs a stdio program (for
example an MCP server) inside that boundary [E-readme], and pi-mcp's `PipeTransport` accepts it directly [M-readme].

**Durable itself has no network server.** The Durable README describes no HTTP, socket or named-pipe API; it shows
`watch()` producing Chord operations "for example to a remote client", leaving the transport to the host [D-readme]
(no `createServer`/`listen` appears under `packages/durable/src` or `packages/env/src` at this commit). Storage is
single-writer: "One process writes a storage at a time; there is no cross-process locking" [D-readme]. The coding
agent (not Durable) has an RPC mode: JSONL over a child process's stdin/stdout, positioned for "process isolation"
[C-rpc].

**Environment variables leak by default.** `NodeExecutionEnv` builds a command's environment as `process.env`, then
`shellEnv`, then per-call `env`, unless `inheritEnv: false`, in which case only the per-call `env` is passed [D-node];
pi-env follows the same rule with the daemon's own environment [E-sem].

**Hooks can gate and scrub.** `beforeTool` can block, rewrite or park a call (for an Approval), and `afterTool` can
replace any result before the model sees it [D-readme].

## Options compared

| Option | Isolation strength | Windows (dev) | Linux (later) | Daemon ↔ Agent comms | Per-Environment secrets | Cost (RAM / startup) |
|---|---|---|---|---|---|---|
| **A. One container per Agent, tools only** (Harness in daemon, `RemoteExecutionEnv` to a `pi-env` daemon in the Agent's container) | Strong for files, processes and network of tool code: kernel namespaces; rootless Podman runs containers in a user namespace and "containers created by a non-root user are not visible to other users" [P-podman]; `--network none`, `--read-only`, `--memory` available [P-run]. Harness and its storage stay in the daemon process. | Yes, via a Linux VM: Docker Desktop on WSL 2 or Hyper-V [DK-win], or `podman machine` (WSL default, Hyper-V) because containers need a Linux kernel [P-machine]. | Native; rootless Podman [P-podman] or rootless Docker [DK-rootless]. | stdio frames of `pi-env serve` [E-proto]; the `Connection` command can be any argv [E-conn], so a container exec command is plausible (**inference, untested**). MCP Connectors via `openProcess` + `PipeTransport` [E-readme][M-readme]. | Container secrets mounted as files under `/run/secrets/` [DK-secrets][P-secret], not committed to images [P-secret]. LLM provider keys never enter the container [E-readme]. | One VM shared by all containers on Windows (default 50% of host RAM [WSL]; Docker Desktop requires 8 GB host RAM [DK-win]). Per container: the Rust daemon plus whatever tools run; no first-party figure found, needs measuring. |
| **B. One container per Agent, whole Agent inside** (a Durable Harness per container) | Strongest: Harness, storage, Connector code and model keys all inside the boundary [C-sec]. | As A. | As A. | Alfred must define it: Durable has no server [D-readme]. Options: stdio of `podman exec`/`docker exec`, HTTP on a container port, or a Unix socket on a mounted volume [N-net]. | As A, plus the Agent's model key must be inside, where any tool process can read it [C-cont]. | One Node process + Durable per Agent on top of A; no first-party figure found. |
| **C. Separate OS user per Agent** (pi-env or Node child running as that user) | Medium: Pi notes a dedicated user "can narrow those permissions, but Pi still shares the operating system and network" [C-sec]. | Weak fit: Node's `process.setuid` is "only available on POSIX platforms (i.e. not Windows or Android)" [N-proc]; running as another Windows account needs a service or credential-based launch outside Node. | Good: `spawn` takes `uid`/`gid` [N-cp]; file modes protect data. | stdio of the child [N-cp]; or a Unix socket / Windows named pipe; `readableAll`/`writableAll` default `false` [N-net]. | Per-user files with 0600; env via `spawn({ env })`, default is `process.env` [N-cp]. | Lowest: one process per Agent, no VM. |
| **D. Same user, per-Agent directory** (`NodeExecutionEnv`/`LocalExecutionEnv` with a per-Agent `cwd`) | None against hostile code: the working folder "does not prevent commands from accessing other paths" [C-sec]. | Yes [E-readme]. | Yes. | In-process. | Only by discipline (`inheritEnv: false` [D-node]). | Lowest. |
| **E. Node permission model / worker threads** | Not a boundary: the permission model "does not protect against malicious code" and symlinks are followed outside granted paths [N-perm]; workers are threads in one process that can share memory [N-worker]. | Yes. | Yes. | In-process / `postMessage`. | Worker `env` defaults to a copy of `process.env` [N-worker]. | Low. |
| **F. Micro-VM per Agent** (Gondolin, OpenShell, Docker Sandboxes) | Strong (VM boundary) [C-cont]. | Gondolin needs QEMU [C-cont]; others are separate products. | Yes. | Product-specific [C-cont]. | Docker Sandboxes / OpenShell can keep provider keys outside and substitute them at a proxy [C-cont]; Gondolin inherits host env [C-cont]. | Highest; not measured here. |

## Secrets without leaks

1. **Never via environment variables of the daemon.** Docker warns env vars "are often available to all processes"
   and "can also be printed in logs" [DK-secrets]; `NodeExecutionEnv` and pi-env inherit the parent environment unless
   `inheritEnv: false` [D-node][E-sem]. Start each `pi-env` daemon with a minimal environment and pass `inheritEnv:
   false` on tool `exec` calls that should not see Connector credentials.
2. **File-mounted secrets per container.** Compose mounts secrets at `/run/secrets/<name>` [DK-secrets]; Podman
   `--secret ...,type=mount` (or `type=env`) [P-run], with uid/gid/mode on the mount, and secrets are not stored in the
   image or in `podman commit`/`podman export` output [P-secret]. The Connector process inside reads the file; the daemon
   only names the secret.
3. **Keep model credentials in the daemon.** With option A, pi-ai resolves provider keys in the Harness process and
   pi-env keeps "storage and credentials" local [E-readme]; the Agent's tools never hold them.
4. **Daemon logs.** pi-env's `onLog` receives the daemon's and transport's diagnostic text [E-conn]; route it through a
   redacting logger rather than straight to disk.
5. **LLM context.** A secret only reaches the model if a tool result contains it. An `afterTool` hook can replace any
   result before the model sees it [D-readme]; Pi warns that sessions "can contain ... credentials exposed during the
   conversation" [C-sec], so per-Agent storage must be treated as secret-bearing too.

## Cost on a small always-on box

First-party sources give requirements, not per-container overhead:

- Windows: containers run inside one shared Linux VM [P-machine]; WSL 2 gives that VM 50% of host RAM by default,
  configurable with `memory=` in `.wslconfig`, and shuts an idle VM down after `vmIdleTimeout` (60 s default) [WSL].
  Docker Desktop needs 8 GB host RAM and is free only for personal use, education, non-commercial open source and
  businesses under 250 employees and $10 M revenue [DK-win].
- Linux: no VM; rootless Podman is daemonless [P-podman], so idle cost is the container's own processes.
- In option A an idle Agent container holds only the `pi-env` Rust daemon; `--memory` caps it [P-run].
- Startup: no official numbers found. The pi-env connection is lazy ("nothing happens until the first operation") and
  reconnects on the next request after a loss [E-readme][E-proto].

Real RAM and cold-start numbers need a measurement spike (see open questions).

## Implications for Alfred

**Recommended default: option A, one rootless container per Agent for tool execution, Harness in the daemon.**
The Alfred daemon runs Pi Durable with one storage per Agent (single writer [D-readme]) and an `env` function that maps
each Agent's conversations to a `RemoteExecutionEnv` whose `Connection` starts `pi-env serve` inside that Agent's
container over stdio [E-readme][E-conn]. Connectors that are MCP stdio servers run inside the same container through
`openProcess` + `PipeTransport` [E-readme][M-readme]; their secrets are file-mounted container secrets
[DK-secrets][P-secret]. Model keys stay in the daemon, the container has no network unless its Connectors need it
[P-run], and `beforeTool` is where Approvals park [D-readme]. On Linux use rootless Podman [P-podman]; on Windows use
Podman machine or Docker Desktop on WSL 2 [P-machine][DK-win], with the same Linux image, since pi-env ships Linux
binaries [E-readme].

**Fallback: option C on Linux, option D on Windows development only.** If no container runtime is available, run each
Agent's `pi-env` daemon as a dedicated Linux user via `spawn({ uid, gid, env })` [N-cp] with per-user 0600 secret
files. On a Windows dev box without containers, run `LocalExecutionEnv` per Agent directory with `inheritEnv: false`
and fake secrets; this is **not** an Environment in the glossary's sense [C-sec] and must never hold real Owner data.
Do not rely on the Node permission model or worker threads as a boundary [N-perm][N-worker].

## Answer

Pi has no sandbox of its own, but Pi Durable is designed for exactly this split: the Harness takes a per-conversation
`env` function, and `@earendil-works/pi-env` provides a `RemoteExecutionEnv` that runs every tool and stdio process
(including MCP Connectors) inside a small Rust daemon spoken to over stdin/stdout, while the harness, its storage and
model credentials stay in the host process. So Alfred should keep one Durable Harness in its daemon with one storage
per Agent, and give each Agent an exclusive Environment as a rootless container (Podman on Linux; Podman machine or
Docker Desktop on WSL 2 for Windows development) running `pi-env`, with that Agent's Connector secrets mounted as
container secret files and never passed through environment variables, daemon logs, or tool results (`afterTool` can
scrub). Running a whole Durable worker per container is stronger but requires Alfred to invent its own transport, since
Durable ships none. Without containers, a per-Agent Linux user is an acceptable fallback; the Node permission model,
worker threads and per-directory `cwd` are not isolation. RAM and startup cost per container are not documented
first-party and need measuring.

## Open questions

- Does `Connection({ command: ["podman", "exec", "-i", <container>, "/path/pi-env"] })` work end to end (sync line,
  liveness, cleanup on container stop)? Spike it on Windows (Podman machine) and Linux.
- Measured idle RSS and cold start of: an Agent container with only `pi-env`; with one MCP Connector; the shared WSL VM.
- Podman machine vs Docker Desktop on the Windows dev box (licensing [DK-win], rootless default [P-machine]).
- Where each Agent's Durable storage file lives and who can read it, given transcripts can contain secrets [C-sec].
- Network policy per Agent container: which Connectors need egress, and to which Systems of record.
- Secret provisioning and rotation: who creates the Podman/Compose secrets, and from what source.
