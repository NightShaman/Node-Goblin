# Settings guide

*On narrow screens, swipe tables horizontally to see every column.*

Node Goblin supplies declarative settings data and action handlers. BURROW renders the controls. The mod does not ship a standalone web server or a standalone settings application.

| Section | Purpose | Important behavior |
| --- | --- | --- |
| Controller & TLS | Enable listener, choose bind host/port, save or clear TLS material | Saved listener/TLS changes require BURROW restart |
| Pending pairings | Compare pairing transcript codes; approve/reject a host | Requires a current live challenge and host confirmation for first no-CA pairing |
| Gateways | View trust and live metadata; provision HMAC credentials; revoke | Secret input is not returned by the settings API |
| Agent assignments | Select local or gateway execution and workspace | Writes the Core agent API and applies to future turns |

## Controller and TLS

The initial listener is disabled, bound to `127.0.0.1:7443` when enabled with defaults. Saving settings does not reconfigure the active listener in place. Inspect its reported state after restart and verify an actual connection.

You can save a key and certificate together, with an optional CA. Clearing TLS removes saved material. Both Save TLS and Clear TLS ask for confirmation about changed certificate pins and possible verified host unpair/re-pair; clearing and restarting can generate a different certificate. The controller cannot diagnose a host-side pin mismatch. When the controller is enabled and required key/certificate material is absent, activation attempts to generate a self-signed RSA-3072 certificate using OpenSSL. Certificates generated here are configured for 3,650 days, with metadata suggesting rotation after nine years; there is no automatic rotation scheduler in this repository.

The UI password-style fields prevent redisplaying existing secret values. They do not replace access control over the BURROW session, secrets store, browser, or backups. A supplied CA alone does not document a requirement for TLS client certificates; application-layer gateway identity still matters.

## Trust and connection status

Approved and connected are separate conditions. A trusted but offline host can appear disconnected. Gateway metadata includes implementation name, reported version/protocol, connected time, and last-seen time. Last-seen time advances on incoming protocol data; there is no periodic heartbeat scheduler in this repository. The gateway can return current bounded hostname, platform, and interface IPs when Core explicitly requests `hello`; these are local observations, not persisted reachability, primary-route, or verified LAN claims. Existing Settings/UI do not automatically display them.

A process list in gateway health is the controller's view of accepted operations on that connection. It is not a full operating-system process inventory.

## Agent assignments and access

Choose a configured, approved gateway and an absolute workspace, then save. This updates the Core agent execution environment for future turns. There is no additional per-agent Node Goblin capability approval. An assignment does not create a workspace, grant host filesystem permissions, or sandbox the agent; the `burrow` service account needs access and defines the operating-system authority available to execution.

## Telemetry

Telemetry configuration belongs to Core Settings, not a separate Node Goblin collector form. Node Goblin forwards that configuration to authenticated hosts and newly connected gateways. A host's explicit `OTEL_*` endpoint takes precedence; see [telemetry overrides](configuration.md#telemetry-overrides). Telemetry failure does not replace process-result or journal evidence.

## Operation history

Operation activity is in **Archive → MODS → Node Goblin**. Controller, pairing,
gateway and assignment configuration remain here. Archive provides metadata
search, gateway/date filtering, paging, selection and refresh through the mod's
existing Archive contribution; it does not add a separate activity page.

The controller listener retains a volatile window (256 entries by default).
Restart, capacity eviction and gateway revocation can remove entries. This is not
complete durable execution history, the gateway replay journal, or an operating
system process inventory. No commands, environment values or raw output are
projected by the Archive endpoint.

## Troubleshooting an action

Save errors include the HTTP response text or a fallback status-based message. For controller and trust changes, check whether `restartRequired` is true in the route contract. The UI does not provide a universal success/restart orchestration layer.

[API reference](api.md) lists the exact routes; [operations](operations.md) covers recovery.

## Source references

- [`ui/settings.js`](https://github.com/GoblinKing-Burrow/Node-Goblin/blob/main/ui/settings.js)
- [`server/index.mjs`](https://github.com/GoblinKing-Burrow/Node-Goblin/blob/main/server/index.mjs)
- [`gateway/lib/controller-listener.mjs`](https://github.com/GoblinKing-Burrow/Node-Goblin/blob/main/gateway/lib/controller-listener.mjs)
