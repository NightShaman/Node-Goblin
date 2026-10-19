# Wire protocol and process execution

*On narrow screens, swipe tables horizontally to see every column.*

The daemon accepts one JSON request per line and emits JSON lines. Protocol version is `1.0`. It can run over local stdio or over the authenticated outbound TLS connection. These are application envelopes rather than a claim of JSON-RPC compatibility.

## Request and response shapes

```json
{"id":"request-1","method":"hello","params":{}}
```

```json
{"type":"response","requestId":"request-1","ok":true,"result":{"name":"burrow-host-gateway","protocolVersion":"1.0","transport":"stdio-jsonl"}}
```

`requestId` correlates a transport request. `operationId` identifies execution for deduplication/replay and must be kept stable across a safe retry of the same operation. They serve different purposes.

| Method | Parameters | Result |
| --- | --- | --- |
| `hello` | None | Name, implementation version, protocol version, transport |
| `health` | None | Status and active operation IDs |
| `telemetry.configure` | `{enabled, endpoint, headers?}` | Validated in-memory telemetry configuration status |
| `process.exec` | Operation ID and process options | Accepted envelope, stream/terminal events, terminal response |
| `filesystem.execute` | Operation ID, tool, arguments | Accepted envelope and terminal filesystem result |
| `cancel` | `operationId` | `{operationId, cancelling}`; cancellation request is not terminal evidence |
| `shutdown` | None | Idle-daemon administrative/development stop; complete active operations first |

Malformed JSON produces an `invalid_json` protocol error. Unsupported methods produce `unknown_method`. Network authentication messages are handled by the transport before daemon dispatch.

After authentication, Core may send `telemetry.configure` with `{enabled, endpoint, headers?}`. The gateway validates it and applies it in memory to current and future remote execution spans. This is the normal centrally managed configuration path; host `OTEL_EXPORTER_OTLP_*` variables remain optional overrides and take precedence. Configuration is never journaled, and status reports only whether headers are configured—not their values.

Core may include a validated `traceContext` object containing W3C version-00 `traceparent` and optional `tracestate` on `process.exec` and `filesystem.execute`. The controller and gateway both validate it and forward it only as transport context. It is excluded from derived operation IDs, controller correlation, and gateway replay/idempotency digests, and it is removed before child-process or filesystem-runner invocation. When telemetry is enabled through Core Settings or an optional host override, Node Goblin emits one bounded remote server span joined to Core's tool span. The sampled flag and trace state are preserved; an unsampled remote parent executes normally without export. Only validated operation kind/tool/target/operation identifiers are attributes. Commands, arguments, working directories, environment/protected values, filesystem paths/content/queries/output, and raw errors are never exported. Collector failure never changes operation outcome.

Use `shutdown` only after active operations have completed. For packaged deployments, use the systemd service lifecycle to stop the daemon; do not rely on this protocol method to drain or cancel active work.

## Process options

Choose exactly one execution form:

```json
{"operationId":"demo-001","executable":"node","args":["-e","console.log('hello')"],"cwd":"/srv/burrow/workspaces/example","timeoutMs":30000}
```

or a shell command string. `command` uses `shell: true`; `executable` with an array of string `args` uses `shell: false`. A command cannot also supply an executable or a nonempty args array.

| Option | Behavior |
| --- | --- |
| `cwd` | Requested working directory; otherwise daemon working directory |
| `env` | String-coerced environment additions over the daemon environment |
| `timeoutMs` | Positive integer; default 30,000 ms |
| `deadlineMs` | Optional absolute deadline using the supplied clock |
| `maxOutputBytes` | Positive integer; combined captured stdout/stderr cap, default 1 MiB; overflow truncates capture and sends SIGTERM to the process/group |
| `operationId` | Explicit identifier; daemon can derive a hash when absent, but controller HTTP execution requires it |
| `protectedBindingMetadata` | Safe binding metadata retained for digest/correlation |
| `protectedValues` and `protectedDelivery` | Internal authenticated one-shot delivery; not ordinary persisted request data |

Do not interpolate untrusted text into a shell command. Prefer explicit executable/argument arrays when shell syntax is unnecessary.

These are daemon protocol options. The [Core adapter](architecture.md#manifest-and-activation) forwards a narrower subset and does not forward `deadlineMs` or `maxOutputBytes` in this baseline. Output overflow sends SIGTERM; it does not by itself schedule the one-second SIGKILL escalation used for cancellation and timeouts.

## Events and terminal evidence

An `accepted` envelope includes the operation ID and protocol version. `process.stream` events include stream (`stdout` or `stderr`), sequence, data, and truncation state. `process.terminal` includes process evidence: timestamps, duration, working directory, effective UID/GID, hostname, execution form, exit code/signal, cancellation/timeout flags, captured output, and output digests.

A successful transport response does not imply process success. Inspect `exitCode`, `timedOut`, `cancelled`, `signal`, and truncation. The Core adapter treats exit code zero with neither cancellation nor timeout as a successful shell tool result.

On POSIX, child processes start detached and termination targets the process group. Cancellation and timeout first send SIGTERM, then attempt SIGKILL after one second, with a fallback settlement timer. This is process lifecycle management, not full containment of processes that escape the group.

## Protected values

Only process execution accepts protected values. The daemon checks valid environment names and nonempty string values and binds delivery to gateway ID, connection ID, request ID, and operation ID supplied by the authenticated transport. Protected environment values override ordinary environment entries. Literal matching values are redacted from stdout/stderr stream data and captured terminal stdout/stderr before journal/transport accumulation. This does not redact command, argument, or working-directory metadata and is not general data-loss prevention for transformed or encoded secrets.

One-shot protected values and delivery bindings are excluded from the canonical request digest and journal input. A replay attempt that resends protected values returns `protected_redelivery_forbidden`. Do not build an automatic retry that blindly re-delivers credentials.

## Replay guarantees and limits

<div class="diagram-scroll" role="region" tabindex="0" aria-label="Scrollable architecture diagram" markdown="1">

```mermaid
flowchart TD
  R[Execution request] --> J{Completed journal entry?}
  J -->|Yes and matching digest| REPLAY[Return stored outcome]
  J -->|Yes and different digest| CONFLICT[Operation ID conflict]
  J -->|No| A{Operation active?}
  A -->|Yes| BUSY[In progress or conflict]
  A -->|No| RUN[Accept and execute]
  RUN --> STORE[Store terminal outcome]
  STORE --> RES[Return response]
```

</div>

*On narrow screens, scroll the diagram horizontally to read all labels.*

The journal defaults to five minutes from completion and at most 256 completed operations across process and filesystem work. Capacity eviction removes the oldest retained entries; replay does not refresh their expiry. Entries are expired/evicted, so ID reuse outside that retained window can execute again.

With a state directory or explicit journal file, completed outcomes are saved in `operations.json` (or that file); without either, the journal is memory-only. Only completed outcomes are journaled, not active work or thrown execution failures. A crash between side effects and journal persistence leaves an ambiguous result. The implementation therefore provides bounded completed-operation replay, not a universal exactly-once guarantee.

Before retrying a mutating operation after uncertainty, inspect host-side effects. Reuse the same operation ID only with an unchanged request and an understood replay window.

## Stdio development example

```bash
printf '%s
' '{"id":"hello-1","method":"hello","params":{}}'   | node gateway/cli.mjs
```

Do not use this example with a controller URL already set in the environment: that switches the CLI into network mode. `GatewayClient` provides a local child-process helper for requests and collected execution events; callers still own process lifetime and error handling.

## Source references

- [`gateway/lib/protocol.mjs`](https://github.com/GoblinKing-Burrow/Node-Goblin/blob/main/gateway/lib/protocol.mjs)
- [`gateway/lib/daemon.mjs`](https://github.com/GoblinKing-Burrow/Node-Goblin/blob/main/gateway/lib/daemon.mjs)
- [`gateway/lib/process-runner.mjs`](https://github.com/GoblinKing-Burrow/Node-Goblin/blob/main/gateway/lib/process-runner.mjs)
- [`gateway/lib/journal.mjs`](https://github.com/GoblinKing-Burrow/Node-Goblin/blob/main/gateway/lib/journal.mjs)
- [`gateway/lib/output-frame.mjs`](https://github.com/GoblinKing-Burrow/Node-Goblin/blob/main/gateway/lib/output-frame.mjs)
- [`gateway/lib/network-transport.mjs`](https://github.com/GoblinKing-Burrow/Node-Goblin/blob/main/gateway/lib/network-transport.mjs)
- [`gateway/lib/client.mjs`](https://github.com/GoblinKing-Burrow/Node-Goblin/blob/main/gateway/lib/client.mjs)
- [`server/index.mjs`](https://github.com/GoblinKing-Burrow/Node-Goblin/blob/main/server/index.mjs)

### Encoded output and reconnect limits

JSONL output frames are capped at 2 MiB including the envelope, JSON escaping,
UTF-8 encoding and newline. Capture/read limits remain upper bounds, not delivery
size promises. Process text and successful file-read content may be shortened
further with `truncated: true` and `transportTruncated: true`. Output digests and
file content hashes describe the delivered text. Transport-shortened file reads
also set `incomplete: true`, omit the original result fingerprint, and set
`nextOffsetBytes: null`; request a smaller byte range rather than assuming the
original next offset is resumable. Non-text results or metadata that cannot fit
return an explicit `output_frame_too_large` outcome/error instead of silently
omitting entries. Custom capture/read bounds do not raise the wire limit.

During disconnect or authentication, application events and responses are
intentionally dropped rather than buffered. Host work continues. Once reconnect
authentication is ready, new application output can flow; retry the same stable
operation ID to recover a completed outcome from the finite journal. Terminal
process evidence and the initial response share the bounded journal outcome;
replay envelopes are also checked against the encoded frame limit.
