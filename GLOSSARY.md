# Alfred

A self-hosted personal assistant that acts on the owner's behalf across their own systems of record, asking for approval before it changes anything.

## Language

### Who acts

**Owner**:
The person Alfred serves; the only one who grants Approvals and chooses which model provider each Agent uses.
_Avoid_: user, admin

**Agent**:
A named assistant inside Alfred with its own instructions, model choice, allowed Connectors and secrets.
_Avoid_: bot, persona, assistant

**Main Agent**:
The Agent the Owner talks to by default (named "Alfred" unless the Owner renames it). It knows every Subagent's role and capabilities and answers the Owner itself, delegating where a Subagent knows better.
_Avoid_: chief, supervisor, router, orchestrator

**Subagent**:
Any Agent other than the Main Agent, responsible for one topic (for example finance, health or home). The Owner can also talk to it directly.
_Avoid_: specialist, worker, employee, child agent

**Delegation**:
The Main Agent asking a Subagent a question and receiving the Subagent's answer back, which the Main Agent then uses in its own reply to the Owner.
_Avoid_: routing, dispatch

**Handoff**:
The Owner moving a topic from the Main Agent to a Subagent and continuing to talk to that Subagent directly.
_Avoid_: transfer, redirect

**Thread**:
One durable conversation inside a single Agent: the Owner's chat with it, a Briefing run, or a run started by a Trigger. An Agent has many Threads; a Thread never spans Agents.
_Avoid_: conversation, session, chat

**Environment**:
The isolated boundary an Agent runs in, holding that Agent's secrets and data so no other Agent can reach them.
_Avoid_: sandbox, workspace, container

### Data and integrations

**System of record**:
A self-hosted application that owns a slice of the owner's data (documents, finances, calendar, home). Alfred reads and changes it but never becomes the place the data lives.
_Avoid_: backend, service, data store

**Connector**:
Alfred's integration with exactly one System of record, regardless of how it is wired (MCP server or native code).
_Avoid_: plugin, integration, adapter

**Tool**:
One action a Connector exposes, always carrying a Risk level.
_Avoid_: function, command, capability

**Risk level**:
The declared consequence of running a Tool: `read` (observes only), `write` (changes data), or `destructive` (changes data in a way that is hard or impossible to undo).
_Avoid_: permission, scope

**Trigger**:
An inbound event from a Connector or a schedule that starts work without the owner asking.
_Avoid_: hook, event, job

### Human in the loop

**Approval**:
A `write` or `destructive` Tool call that has been parked until the owner accepts or rejects it.
_Avoid_: confirmation, permission request

**Standing Approval**:
A scoped permission the Owner grants in advance, so that matching `write` or `destructive` Tool calls run without a new Approval.
_Avoid_: whitelist, auto-approve, rule

**Briefing**:
A scheduled digest Alfred assembles from several Connectors and pushes to the owner's phone.
_Avoid_: report, summary, digest
