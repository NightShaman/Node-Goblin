# Configuration reference

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

Keep the packaged service's state directory at `/var/lib/burrow-host-gateway` when using the operator wrapper. Although the daemon accepts a different `BURROW_GATEWAY_STATE_DIR`, the wrapper's `connect`, `status`, `pairing-code`, and `unpair` commands use the fixed packaged state path and do not read that override. A custom daemon state directory needs separately coordinated operational tooling.

Library constructors additionally support programmatic options such as reconnect intervals, journal TTL/limit, injected clocks, and test TLS implementations. Those options do not imply matching environment variables. `HOSTNAME` is a library fallback gateway ID, but the network CLI explicitly requires `BURROW_GATEWAY_ID`.

Installer/operator controls are separate: `BURROW_GATEWAY_ROOT` selects a staging root, `SYSTEMCTL` selects the operator command's systemctl executable, and `SOURCE_DATE_EPOCH` controls deterministic archive timestamps. They are not gateway protocol settings.

## Controller settings names

| Name | Stored value |
| --- | --- |
| `targets` | API target list: ID, name, HTTP(S) base URL, enabled |
| `controller` | `{enabled, host, port}`; defaults false, `127.0.0.1`, 7443 |
| `controllerGateways` | Trusted gateway/controller identity metadata |
| `pendingNodeGoblinPairings` | Pending public identity and transcript records |
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
| State directory `/operations.json` | Completed-operation journal with results/digests/expiry |

“State directory /…” means a child of the configured state directory, not a filesystem-root path. Protect backups as credentials and potentially sensitive command/file output. The packaged unit uses `UMask=0077`; constructor use outside it inherits the caller's filesystem policy.

## Service behavior

The checked-in unit runs as `burrow:burrow`, working directory `/opt/burrow-host-gateway`, starts `/usr/bin/env node .../cli.mjs`, restarts always after five seconds, sets a private temporary directory, and includes `ReadWritePaths` for the state directory. Do not interpret that last directive alone as a complete filesystem sandbox. Review the effective unit and account permissions on your host.

## Source references

- [`gateway/cli.mjs`](https://github.com/NightShaman/Node-Goblin/blob/12d0f1daf74516e1f0120c80ad4716bd09e1dead/gateway/cli.mjs)
- [`gateway/deploy/gateway.env.example`](https://github.com/NightShaman/Node-Goblin/blob/12d0f1daf74516e1f0120c80ad4716bd09e1dead/gateway/deploy/gateway.env.example)
- [`gateway/deploy/burrow-host-gateway.service`](https://github.com/NightShaman/Node-Goblin/blob/12d0f1daf74516e1f0120c80ad4716bd09e1dead/gateway/deploy/burrow-host-gateway.service)
- [`server/index.mjs`](https://github.com/NightShaman/Node-Goblin/blob/12d0f1daf74516e1f0120c80ad4716bd09e1dead/server/index.mjs)
- [`gateway/lib/journal.mjs`](https://github.com/NightShaman/Node-Goblin/blob/12d0f1daf74516e1f0120c80ad4716bd09e1dead/gateway/lib/journal.mjs)
