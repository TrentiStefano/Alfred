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

**Briefing**:
A scheduled digest Alfred assembles from several Connectors and pushes to the owner's phone.
_Avoid_: report, summary, digest
