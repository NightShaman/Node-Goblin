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

The `hello` host metadata includes a bounded `codex: {available, protocol: 1}` capability object indicating executable availability; it must not include credentials, account identity, or auth state. Installer opt-in is `--with-codex`; when selected, install the latest available Codex CLI without pinning a version. Default installation does not install Codex. Successful opt-ins are retained by the package and fetch latest again on later updates. CLI provisioning is outside Node Goblin package rollback.

## Client guidance

Use a fresh unpredictable operation ID per session, open once, send app-server protocol bytes through `write`, poll `read`, and always close in `finally`. The surrounding transport provides confidentiality and peer authentication; do not add a local/network listener.


## Claude transport extension

The same connection-owned channel also supports `claude.open`, `claude.write`, `claude.read` and `claude.close`. The latter three have the same shapes; open additionally receives the controller-owned transient OAuth token and validated headless JSONL arguments. See [the full private Claude contract](protocol.md#private-claude-jsonl-transport) and [installation](installation.md#optional-codex-cli-for-native-minions). Codex, Claude and Gemini share the eight-session gateway limit, but runtime ownership is enforced: a method for one cannot access a session of the other. Both native paths currently use the sanitized `codex_transport_failed` error name.

Host metadata advertises a separate `claude: {available, protocol: 1}` capability. No version, account, token or authentication state survives normalization. Native IPC bypasses ordinary gateway operation journals, Archive activity and gateway spans; native minion observability remains Core-owned. Neither CLI’s authenticated session survives a gateway disconnect.


Gemini also uses the connection-owned `gemini.open/write/read/close` channel. Its transient API-key authentication, bounded private diagnostics and cancellation limits are described in [private Gemini transport and cancellation](protocol.md#private-gemini-transport-and-cancellation). There is no fixed active-session lifetime cap in the current gateway.
