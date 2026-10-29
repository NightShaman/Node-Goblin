# Configuration reference

*On narrow screens, swipe tables horizontally to see every column.*

Configuration lives on both controller and gateway. Changing one side does not automatically rewrite the other.

## Gateway environment

| Variable | Requirement/default | Meaning |
| --- | --- | --- |
| `BURROW_GATEWAY_CONTROLLER_URL` | Optional; absent selects stdio mode | `tls://host:port`; omitted URL port defaults to 443 |
| `BURROW_GATEWAY_ID` | Required nonempty in network CLI mode | Stable gateway identity used by controller trust and assignments |
| `BURROW_GATEWAY_STATE_DIR` | Required in network CLI mode | Identity, trust, pairing, and operation state; packaged unit sets `/var/lib/burrow-host-gateway` |
| `BURROW_GATEWAY_ENROLLMENT_TOKEN` | Optional legacy bootstrap | HMAC enrollment secret; remove from config after successful enrollment |
| `BURROW_GATEWAY_CA_FILE` | Optional CA file | TLS server trust for first strict connection and HMAC deployments |
| `BURROW_GATEWAY_CERT_FILE` | Optional certificate file | Client TLS certificate passed to Node TLS |
| `BURROW_GATEWAY_KEY_FILE` | Optional key file | Client TLS key passed to Node TLS |
| `BURROW_FILESYSTEM_TRAVERSAL_ENTRIES` | Positive integer; 4,000 | Default find/search traversal budget |

The packaged environment file is `/etc/burrow-host-gateway/gateway.env`, root-owned and intended to be `root:burrow` mode `0640`. systemd reads it as an environment file, not a shell script. Do not use shell substitution or put reusable secrets into command-line arguments.

Keep the packaged service's state directory at `/var/lib/burrow-host-gateway` when using the operator wrapper. Although the daemon accepts a different `BURROW_GATEWAY_STATE_DIR`, the wrapper's `connect`, `apply`, `status`, `pairing-code`, `confirm-pairing`, and `unpair` commands use the fixed packaged state path and do not read that override. A custom daemon state directory needs separately coordinated operational tooling.

Library constructors additionally support programmatic options such as reconnect intervals, journal TTL/limit, injected clocks, and test TLS implementations. Those options do not imply matching environment variables. `HOSTNAME` is a library fallback gateway ID, but the network CLI explicitly requires `BURROW_GATEWAY_ID`.

Installer/operator controls are separate: `BURROW_GATEWAY_ROOT` selects a staging root, `SYSTEMCTL` selects the operator command's systemctl executable, and `SOURCE_DATE_EPOCH` controls deterministic archive timestamps. They are not gateway protocol settings.

## Telemetry overrides

Core Settings normally delivers telemetry configuration through the provider. Current controller-delivered destinations support independent OTLP/HTTP JSON or protobuf trace export, trace enablement, private headers, and TLS verification/CA settings. Node Goblin exports traces, not Core's metrics. Upgrade both the controller mod and host gateway for this multi-destination and per-operation transport. The host also supports these environment overrides:

| Variable | Default / precedence |
| --- | --- |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Exact trace URL; takes precedence over the base endpoint and Core Settings |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base URL; runtime appends `/v1/traces`; takes precedence over Core Settings |
| `OTEL_EXPORTER_OTLP_TRACES_HEADERS` / `OTEL_EXPORTER_OTLP_HEADERS` | Generic and trace-specific headers merge case-insensitively, with trace-specific values winning; comma-separated, percent-decoded `key=value` pairs (values may contain `=` padding) |
| `OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE` / `OTEL_EXPORTER_OTLP_CERTIFICATE` | CA certificate file for a host-selected HTTPS endpoint; trace-specific path wins |
| `OTEL_EXPORTER_OTLP_TRACES_CLIENT_CERTIFICATE` / `OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE` | Client certificate file; trace-specific path wins |
| `OTEL_EXPORTER_OTLP_TRACES_CLIENT_KEY` / `OTEL_EXPORTER_OTLP_CLIENT_KEY` | Client key file; trace-specific path wins |
| `OTEL_BSP_MAX_QUEUE_SIZE` | 512 spans per destination; maximum 4,096 |
| `OTEL_EXPORTER_OTLP_TRACES_TIMEOUT` / `OTEL_EXPORTER_OTLP_TIMEOUT` / `OTEL_BSP_EXPORT_TIMEOUT` | First nonempty setting in the listed order; invalid/nonpositive values fall back to 3,000 ms |
| `OTEL_BSP_SCHEDULE_DELAY` | 1,000 ms |
| `OTEL_BSP_SHUTDOWN_TIMEOUT` | Shutdown override; otherwise trace/general timeout, then effective export timeout |

A host environment endpoint remains active even if Core disables telemetry and selects one environment-owned JSON exporter rather than fan-out to saved destinations. Header-only host overrides also select one owner; they do not distribute host credentials to every saved collector. Controller credentials follow only their own exact trace URL, never a distinct host-selected endpoint. Keep credentials in protected configuration, never in endpoint URLs or command arguments.

For a host-selected HTTPS endpoint, certificate variables above identify local files read when the telemetry runtime starts. Missing or unreadable selected TLS material disables trace export rather than weakening verification. Core-resolved private environment snapshots carry certificate content, not host file paths. Status excludes endpoint URLs, auth values and certificate material.

Exports are best-effort with independent bounded queues and shutdown for each destination. Failed batches can be dropped; OTLP partial-success responses preserve numeric rejected-span counts without logging collector text or retrying accepted spans. Warnings use fixed safe reasons and numeric HTTP status where available, not response bodies, header values or exception text. Collector failure never changes remote operation outcomes.

Configuration changes apply to future admissions. Already-admitted operations keep their original exporter generation. Compatible Core and controller versions also supply an authenticated private transport snapshot so later operations from an older run keep that run's destinations after settings replacement or disable. This is not a public process option and is excluded from execution arguments, operation identity/replay digests, journal/correlation records and result projections. Retiring exports do not block configuration delivery.

## Controller settings names

| Name | Stored value |
| --- | --- |
| `targets` | API target list: ID, name, HTTP(S) base URL, enabled |
| `controller` | `{enabled, host, port}`; defaults false, `127.0.0.1`, 7443 |
| `controllerGateways` | Trusted gateway/controller identity metadata |
| `pendingNodeGoblinPairings` | Pending public identity and transcript records |
| `controllerTrustMutations` | Durable IDs blocked during interrupted trust mutations; do not manually clear to admit uncertain trust |
| `controllerTlsMetadata` | Configured/generated source plus generated certificate dates/host metadata |
| `controllerOperations` | Durable controller correlation: operation, parent run/tool call, target/kind, request digest, state, terminal reference |

The operation store serializes its own read/modify/write transactions. Terminal references contain an outcome digest and replay marker, not full raw process output.

## Controller secret names

| Name | Contents |
| --- | --- |
| `controller.tls.key` | TLS private key |
| `controller.tls.cert` | TLS certificate |
| `controller.tls.ca` | Optional TLS CA |
| `controller.pairing.identity` | JSON Ed25519 pairing identity |
| `controller.gateway.<gatewayId>` | Legacy HMAC shared secret |
| `controller.gateway.publicKey.<gatewayId>` | Approved node public key |

These are logical names in BURROW's mod secret interface. This repository does not define a separate controller secret database path.

## Gateway disk layout

| Path | Purpose |
| --- | --- |
| `/opt/burrow-host-gateway` | Installed JavaScript runtime |
| `/etc/burrow-host-gateway/gateway.env` | Host service configuration |
| `/etc/systemd/system/burrow-host-gateway.service` | Service unit |
| `/usr/local/bin/node-goblin` | Operator command |
| `/usr/local/bin/burrow-host-gateway` | Compatibility symlink to operator command |
| State directory `/node-identity.json` | Node keypair, creation data, optional controller key/fingerprint pins |
| State directory `/controller-trust.json` | HMAC controller trust and reusable shared secret |
| State directory `/controller-enrollment-consumed` | Prevents automatic re-enrollment after consumption/unpair |
| State directory `/pairing-code.json` | Current gateway ID/code and timestamp |
| State directory `/pairing-confirmation.json` | Short-lived local confirmation written by the operator command and consumed by the daemon |
| State directory `/operations.json` | Completed-operation journal with results/digests/expiry |

“State directory /…” means a child of the configured state directory, not a filesystem-root path. Protect backups as credentials and potentially sensitive command/file output. The packaged unit uses `UMask=0077`; constructor use outside it inherits the caller's filesystem policy.

## Service behavior

The checked-in unit runs as `burrow:burrow`, working directory `/opt/burrow-host-gateway`, starts `/usr/bin/env node .../cli.mjs`, restarts always after five seconds, sets a private temporary directory, and includes `ReadWritePaths` for the state directory. Do not interpret that last directive alone as a complete filesystem sandbox. Review the effective unit and account permissions on your host.

## Source references

- [`gateway/lib/otel-runtime.mjs`](https://github.com/GoblinKing-Burrow/Node-Goblin/blob/main/gateway/lib/otel-runtime.mjs)
- [`gateway/cli.mjs`](https://github.com/GoblinKing-Burrow/Node-Goblin/blob/main/gateway/cli.mjs)
- [`gateway/deploy/gateway.env.example`](https://github.com/GoblinKing-Burrow/Node-Goblin/blob/main/gateway/deploy/gateway.env.example)
- [`gateway/deploy/burrow-host-gateway.service`](https://github.com/GoblinKing-Burrow/Node-Goblin/blob/main/gateway/deploy/burrow-host-gateway.service)
- [`server/index.mjs`](https://github.com/GoblinKing-Burrow/Node-Goblin/blob/main/server/index.mjs)
- [`gateway/lib/journal.mjs`](https://github.com/GoblinKing-Burrow/Node-Goblin/blob/main/gateway/lib/journal.mjs)

