# Settings guide

Node Goblin supplies declarative settings data and action handlers. BURROW renders the controls. The mod does not ship a standalone web server or a standalone settings application.

| Section | Purpose | Important behavior |
| --- | --- | --- |
| Controller & TLS | Enable listener, choose bind host/port, save or clear TLS material | Saved listener/TLS changes require BURROW restart |
| Pending pairings | Compare pairing transcript codes; approve/reject a host | Approval enables execution; needs a current live challenge |
| Gateways | View trust and live metadata; provision HMAC credentials; revoke | Secret input is not returned by the settings API |
| Agent assignments | Select local or gateway execution and workspace | Writes the Core agent API and applies to future turns |
| Operation activity | Inspect bounded execution metadata | Omits prompts, parameters, protected values, and raw output |

## Controller and TLS

The initial listener is disabled, bound to `127.0.0.1:7443` when enabled with defaults. Saving settings does not reconfigure the active listener in place. Inspect its reported state after restart and verify an actual connection.

You can save a key and certificate together, with an optional CA. Clearing TLS removes saved material. When the controller is enabled and required key/certificate material is absent, activation attempts to generate a self-signed RSA-3072 certificate using OpenSSL. Certificates generated here are configured for 3,650 days, with metadata suggesting rotation after nine years; there is no automatic rotation scheduler in this repository.

The UI password-style fields prevent redisplaying existing secret values. They do not replace access control over the BURROW session, secrets store, browser, or backups. A supplied CA alone does not document a requirement for TLS client certificates; application-layer gateway identity still matters.

## Trust and connection status

Approved and connected are separate conditions. A trusted but offline host can appear disconnected. Gateway metadata includes implementation name, reported version/protocol, connected time, and last-seen time. Last-seen time advances on incoming protocol data; there is no periodic heartbeat scheduler in this repository.

A process list in gateway health is the controller's view of accepted operations on that connection. It is not a full operating-system process inventory.

## Activity

The UI shows up to 50 activity records. The default listener retains 256 metadata records in memory. The HTTP route bounds its requested limit to 1–256. Activity can show dispatching, running, terminal, or interrupted, plus replay and reconnect hints.

This display is distinct from:

- The gateway's completed-operation replay journal
- The controller's durable operation-correlation records
- Host service logs and operating-system process state

After a restart or disconnect, use all relevant evidence before concluding that an operation failed or never ran.

## Troubleshooting an action

Save errors include the HTTP response text or a fallback status-based message. For controller and trust changes, check whether `restartRequired` is true in the route contract. The UI does not provide a universal success/restart orchestration layer.

[API reference](api.md) lists the exact routes; [operations](operations.md) covers recovery.

## Source references

- [`ui/settings.js`](https://github.com/NightShaman/Node-Goblin/blob/12d0f1daf74516e1f0120c80ad4716bd09e1dead/ui/settings.js)
- [`server/index.mjs`](https://github.com/NightShaman/Node-Goblin/blob/12d0f1daf74516e1f0120c80ad4716bd09e1dead/server/index.mjs)
- [`gateway/lib/controller-listener.mjs`](https://github.com/NightShaman/Node-Goblin/blob/12d0f1daf74516e1f0120c80ad4716bd09e1dead/gateway/lib/controller-listener.mjs)
