# Remote Codex app-server contract (Node Goblin)

This contract exposes an installed Codex CLI app-server to the authenticated controller over the existing secure gateway connection. It creates no listener or additional port. Capability reports only whether `codex` is executable on the host; it does not imply authentication or availability of an account.

## RPC

All requests use the existing authenticated, connection-bound gateway RPC envelope (`id`, `method`, `params`) and standard response/error forms. The authenticated connection identity is the owner of every operation; operations are not transferable across connections.

- `codex.open { operationId, cwd }` starts `codex app-server` interactively in the requested existing working directory. The caller supplies a unique operation ID. Success returns `{ operationId }`; errors are protocol errors.
- `codex.write { operationId, data }` writes one bounded string to that operation's stdin and returns `{ operationId, written }`. No line is implicitly added.
- `codex.read { operationId }` polls and returns `{ operationId, data, done }`, where `data` is a bounded stdout chunk. Stderr is discarded, never returned or logged.
- `codex.close { operationId, signal }` closes stdin when no signal is supplied, or sends a validated termination signal; returns `{ operationId, closed }`. Repeated close is safe.

Unknown operation, non-owner access, malformed input, and resource-limit violations fail closed. Implementation limits apply to concurrent sessions, cwd and data sizes, per-read output, and total lifetime; clients must poll and honor `done`. Disconnect and gateway stop destroy sessions. After child exit, output remains available to drain for at most 60 seconds; the final drained read removes the session. OAuth/authentication payloads must not enter operation journals, logs, traces, or telemetry. No request contents are journaled. The controller must use only this contract and must not relay OAuth secrets via ordinary process execution or diagnostics.

## Host capability

The `hello` host metadata includes a bounded `codex` capability object indicating executable availability (and optionally a safe version string); it must not include credentials, account identity, or auth state. Installer opt-in is `--with-codex`; when selected, install the latest available Codex CLI without pinning a version. Default installation does not install Codex.

## Client guidance

Use a fresh unpredictable operation ID per session, open once, send app-server protocol bytes through `write`, poll `read`, and always close in `finally`. The surrounding transport provides confidentiality and peer authentication; do not add a local/network listener.

