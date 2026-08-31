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

### Authenticated outbound controller transport

Stdio remains the default. A host daemon can instead make a persistent outbound TLS connection (no inbound listening port and no third-party dependencies):

```bash
BURROW_GATEWAY_CONTROLLER_URL=tls://controller.example:7443 \
BURROW_GATEWAY_STATE_DIR=/var/lib/burrow-gateway \
BURROW_GATEWAY_ID=host-123 \
BURROW_GATEWAY_ENROLLMENT_TOKEN='<one-time out-of-band secret>' \
BURROW_GATEWAY_CA_FILE=/etc/burrow/controller-ca.pem \
node gateway/cli.mjs
```

The first start atomically stores the enrollment secret at `<state-dir>/controller-trust.json` with mode `0600`. Later enrollment-token values do not replace established trust; rotate trust by an explicit administrative removal/re-enrollment procedure. Protect both the environment used for first enrollment and the state directory with the gateway OS account. Optional `BURROW_GATEWAY_CERT_FILE` and `BURROW_GATEWAY_KEY_FILE` enable controller-side mTLS policy in addition to the application challenge.

The controller sends `{"type":"auth.challenge","nonce":"<at-least-16-random-characters>"}`. The gateway replies with an HMAC-SHA256 proof bound to the protocol context, gateway ID, and nonce; ordinary JSONL requests are rejected until the controller sends `{"type":"auth.ok"}`. TLS certificate verification is always enabled. A disconnect triggers bounded exponential reconnect and a fresh challenge. Because the same daemon journal remains alive (and is durable in network mode), a controller can safely resend an identical `operationId` after reconnect and receive replay rather than duplicate execution. Events and terminal evidence retain the existing `operationId` correlation.

This transport does not add a policy principal: successful controller authentication reaches the same gateway message model, and child processes continue to execute with the daemon's OS-account permissions. The controller must use unique unpredictable nonces and compare the expected HMAC in constant time. Do not expose the enrollment token in URLs, logs, or command arguments.

### Controller-side TLS gateway listener library

`gateway/lib/controller-listener.mjs` adds the controller-side slice for the same authenticated outbound transport. It accepts outbound TLS sockets from gateways, uses configured per-gateway `{ gatewayId, controllerId, secret }` trust records, sends an unpredictable auth challenge on connect, verifies the HMAC proof with timing-safe comparison, and binds the proof to both controller and gateway identities.

Behavior highlights:

- rejects unknown gateways, bad proofs, malformed auth envelopes, and duplicate live gateway IDs
- tracks authenticated live gateways plus health-style active operation state
- correlates `requestId`, `accepted`, streamed events, and terminal/response messages for controller dispatch callers
- exposes `dispatchProcessExec(gatewayId, params)` and `dispatchCancel(gatewayId, operationId)` without changing the legacy remote-target mod API
- rejects pending controller dispatch promises on disconnect with actionable retry guidance to resend the same `operationId` after reconnect
- preserves replay semantics because the gateway daemon journal still owns operation identity and completed replay
- emits lifecycle events including `gatewaySocketAccepted`, `gatewayAuthenticated`, `gatewayAccepted`, `gatewayEvent`, `gatewayResponse`, `gatewayProtocolError`, `gatewayDisconnected`, and `gatewaySocketError` for later Burrow supervision work

Example library usage:

```js
import fs from 'node:fs';
import { GatewayControllerListener } from './gateway/index.mjs';

const listener = new GatewayControllerListener({
  gateways: [
    { gatewayId: 'host-123', controllerId: 'controller', secret: '<enrolled-shared-secret>' },
  ],
  serverOptions: {
    key: fs.readFileSync('/etc/burrow/controller-key.pem'),
    cert: fs.readFileSync('/etc/burrow/controller-cert.pem'),
    ca: fs.readFileSync('/etc/burrow/gateway-ca.pem'),
    requestCert: true,
    rejectUnauthorized: true,
  },
}).listen(7443);

const result = await listener.dispatchProcessExec('host-123', {
  operationId: 'example-op-1',
  executable: '/bin/echo',
  args: ['hello'],
});
```

## Burrow mod controller boundary

The mod now optionally activates the controller-side TLS listener from its server boundary while retaining the original target API unchanged. Controller configuration is stored under the mod settings namespace as `{ "enabled": true, "host": "127.0.0.1", "port": 7443 }`; it is intentionally configuration-only and never contains key material.

TLS private key, certificate, optional CA, and each enrolled gateway shared secret are read only from Burrow's encrypted mod-secret API:

```text
controller.tls.key
controller.tls.cert
controller.tls.ca                 (optional)
controller.gateway.<gatewayId>
```

Gateway identity metadata is a non-secret `controllerGateways` settings array containing `{ gatewayId, controllerId }`. A listener starts only when enabled and both TLS key and certificate are present. It binds the configured host and port, authenticates gateways through the existing listener, and dispatches under the gateway daemon's OS account; this mod adds no execution policy or privilege escalation layer.

In addition to the legacy `/targets` API, the mod exposes these namespaced operational routes:

```text
GET  /api/mods/remote-nodes/controller
GET  /api/mods/remote-nodes/gateways
POST /api/mods/remote-nodes/gateways/:gatewayId/processes
POST /api/mods/remote-nodes/gateways/:gatewayId/operations/:operationId/cancel
```

`GET /gateways` contains only live gateway ID, status, and active operation IDs. Process dispatch requires an explicit `operationId`; the same ID is forwarded to the gateway and is retained in accepted, event, response, and cancel correlation. This permits safe retry with the same operation ID after a disconnect and preserves daemon journal replay semantics. No endpoint returns controller TLS material or enrollment secrets; known configured secret values are redacted from returned dispatch evidence.

The current Burrow runtime calls `activate` but has no deactivate hook. Activation therefore returns a `close()` lifecycle handle for a lifecycle-aware host; it closes the listener and its authenticated sockets when invoked.

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
