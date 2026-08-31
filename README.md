# Remote Nodes for Burrow

Remote Nodes is a small Burrow mod that stores additional Burrow API targets. Core Burrow uses those targets through its existing UI, API client, chat streaming, sessions, tools, settings, and other product surfaces.

The mod does not reimplement Burrow screens or proxy Burrow APIs. Version 1 stores only:

```text
id
name
baseUrl
enabled
```

Target records live in the mod's namespace in Burrow's existing SQLite settings database.

## Install

Choose the runtime root used by your Burrow installation, then clone this repository into its `mods` directory:

```bash
BURROW_RUNTIME_ROOT="${BURROW_RUNTIME_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/burrow}"
mkdir -p "$BURROW_RUNTIME_ROOT/mods"
git clone https://github.com/NightShaman/burrow-mod-remote-nodes.git \
  "$BURROW_RUNTIME_ROOT/mods/remote-nodes"
```

Restart Burrow after installing or updating the mod.

Other common runtime roots include `/var/lib/burrow` for a system installation and `/data` in Docker.

## Standalone host gateway daemon foundation

This repository also includes a dependency-free standalone Node package at `gateway/`. It does not replace the existing mod API, manifest, storage contract, or tests.

### Boundaries

- Transport is versioned JSON lines over stdio so other transports can adapt without changing the message model.
- OS account permissions are the authority. There is no mandatory policy or allowlist layer in v1.
- The gateway runs local child processes only; it does not proxy Burrow APIs or alter remote target registry behavior.
- Completed operations may be replayed from a bounded journal until TTL expiry. By default the journal is in memory; if `BURROW_GATEWAY_STATE_DIR` is set, the daemon persists an atomic JSON journal at `<state-dir>/operations.json` so replay survives restart.
- Explicit `params.operationId` values are bound to the canonical request digest. Reusing the same operation ID with changed request parameters is rejected with `operation_id_conflict`.
- Output capture is byte-bounded and UTF-8 safe. When the limit is exceeded, the process is terminated and terminal evidence marks `truncated: true`.
- Cancellation is best-effort via process groups on non-Windows platforms.
- `timeoutMs` and `deadlineMs` terminate long-running work and produce terminal timeout evidence.
- The CLI traps `SIGINT` and `SIGTERM` for graceful shutdown.

### Usage

Run directly:

```bash
node gateway/cli.mjs
```

Or from the package directory:

```bash
cd gateway
node cli.mjs
```

Optional durable replay state:

```bash
BURROW_GATEWAY_STATE_DIR=.gateway-state node gateway/cli.mjs
```

Send one JSON object per line on stdin. Example session:

```text
{"id":"1","method":"hello"}
{"id":"2","method":"health"}
{"id":"3","method":"process.exec","params":{"executable":"/bin/echo","args":["hello burrow"]}}
{"id":"4","method":"process.exec","params":{"command":"printf 'shell mode\\n'","operationId":"custom-op-1"}}
{"id":"5","method":"process.exec","params":{"executable":"/bin/sleep","args":["30"],"timeoutMs":1000}}
{"id":"6","method":"cancel","params":{"operationId":"<operation-id>"}}
{"id":"7","method":"shutdown"}
```

Response/event shape examples:

```json
{"type":"response","requestId":"1","ok":true,"result":{"name":"burrow-host-gateway","version":"1.0.0","protocolVersion":"1.0","transport":"stdio-jsonl"}}
{"type":"accepted","requestId":"3","ok":true,"operationId":"<sha256-or-explicit-id>","protocolVersion":"1.0"}
{"type":"process.stream","operationId":"<sha256-or-explicit-id>","stream":"stdout","seq":1,"data":"hello burrow\n","truncated":false}
{"type":"process.terminal","operationId":"<sha256-or-explicit-id>","seq":2,"evidence":{"type":"process.result","startedAt":"2025-01-01T00:00:00.000Z","endedAt":"2025-01-01T00:00:00.010Z","durationMs":10.0,"cwd":"/work","effectiveUid":1000,"effectiveGid":1000,"hostname":"host","mode":"exec","executable":"/bin/echo","args":["hello burrow"],"command":null,"exitCode":0,"signal":null,"cancelled":false,"truncated":false,"timedOut":false,"timeoutReason":null,"timeoutMs":null,"deadlineMs":null,"stdout":"hello burrow\n","stderr":"","stdoutDigest":"<sha256>","stderrDigest":"<sha256>"}}
{"type":"response","requestId":"3","ok":true,"result":{"operationId":"<sha256-or-explicit-id>","replay":false,"outcome":{"type":"process.result"}}}
```

Malformed JSON requests return:

```json
{"type":"error","requestId":"<recovered-if-possible>","ok":false,"error":{"code":"invalid_json"}}
```

### Methods

- `hello`: returns daemon identity and protocol version.
- `health`: returns current status and active operation IDs.
- `process.exec`: executes either `{"executable":"...","args":[...]}` or `{"command":"..."}` and accepts optional `operationId`, `timeoutMs`, `deadlineMs`, `cwd`, `env`, and `maxOutputBytes`.
- `cancel`: requests cancellation by operation ID.
- `shutdown`: aborts active work, reports `stopping`, and closes gracefully.

### Canonical operation IDs and replay

If the caller omits `params.operationId`, the daemon derives one from a canonical SHA-256 hash of:

```json
{"method":"process.exec","params":{...}}
```

For explicit operation IDs, the daemon separately stores the canonical request digest without `operationId` and rejects later reuse of that operation ID with changed request parameters.

Reissuing the same completed request before journal expiry returns a replayed completed result instead of rerunning the process. Durable replay across restart is available only when `BURROW_GATEWAY_STATE_DIR` is set.

### Local protocol client

`gateway/lib/client.mjs` exposes a small stdio client for tests and local integration. It spawns the CLI, tracks request IDs, captures the `accepted` envelope, and correlates later operation events by `operationId`.

## Contract

The manifest contributes one host-owned API-target endpoint and a declarative Settings slot. Core owns the Settings layout and rendering; this mod only declares metadata and requests the host-owned `apiTargets` capability:

```json
{
  "contributions": {
    "apiTargets": "/api/mods/remote-nodes/targets",
    "settings": [{
      "id": "remote-targets",
      "navigation": { "title": "Remote Nodes", "description": "Configure remote Burrow nodes." },
      "primary": { "title": "Connection", "capability": "apiTargets" },
      "inventory": {
        "title": "Known nodes",
        "capability": "apiTargets",
        "emptyState": { "title": "No remote nodes", "description": "Add one to begin." }
      }
    }]
  }
}
```

The `navigation` metadata is rendered in Column 2, `primary` in Column 3, and optional `inventory` in Column 4. Mods do not provide markup, styles, layout instructions, or executable UI behavior.

The endpoint supports:

```text
GET    /api/mods/remote-nodes/targets
POST   /api/mods/remote-nodes/targets
PUT    /api/mods/remote-nodes/targets/:id
DELETE /api/mods/remote-nodes/targets/:id
```

Core Burrow renders target settings, combines resources from enabled targets, preserves node provenance, and routes operations to the node that owns each resource.

Remote Burrow APIs must be reachable by the browser. Burrow core provides CORS for its API routes. Version 1 adds no remote credential contract.

## Test

Existing mod tests:

```bash
node --test server/index.test.mjs
```

Gateway plus mod tests from repo root:

```bash
node --test gateway/*.test.mjs server/index.test.mjs
```

Gateway package tests from inside `gateway/`:

```bash
cd gateway
npm test
```
