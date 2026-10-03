# HTTP API reference

The server module registers relative routes with BURROW's mod API. Their public prefix is **`/api/mods/node-goblin`**. Authentication, session handling, request admission, and route hosting belong to BURROW Core; this repository does not implement a standalone HTTP authentication layer. Do not expose these administrative routes independently.

A route success usually contains `ok: true`. Validation throws an error carrying an HTTP status, normally 400. The host determines final HTTP serialization. A dispatch response can contain an unsuccessful nested process/filesystem outcome even when the route request was accepted.

## API targets

| Method and relative path | Input | Success |
| --- | --- | --- |
| `GET /targets` | None | `{ok, targets}` |
| `POST /targets` | `{id, name, baseUrl, enabled?}` | 201 `{ok, target}` |
| `PUT /targets/:id` | Complete target object with unchanged ID | `{ok, target}` |
| `DELETE /targets/:id` | Path ID | `{ok}` |

IDs begin with a letter/digit and then use letters/digits/dot/underscore/hyphen. Uppercase and lowercase characters are accepted, but IDs are stored and compared case-sensitively; the exact lowercase ID `local` is rejected. Keep gateway ID spelling and case identical across host configuration, trust, routes, and assignments. Names are nonempty. URLs must be HTTP(S), have no username/password, query, or fragment; trailing path slashes are normalized. Enabled defaults true unless explicitly false. Duplicate creation returns 409 `api_target_exists`; unknown update/delete returns 404 `api_target_not_found`; ID changes return `target_id_immutable`.

These targets are distinct from paired gateway execution identities.

## Controller and TLS

| Method and relative path | Input | Success |
| --- | --- | --- |
| `GET /controller` | None | `{ok, controller}` with active config, TLS flags/metadata, optional error |
| `PUT /controller` | `{enabled, host, port}` | `{ok, controller, restartRequired: true}` |
| `PUT /controller/tls` | Nonempty `{key, cert}`, optional `ca` | `{ok, restartRequired: true}` |
| `DELETE /controller/tls` | None | Clears TLS secrets/metadata; restart required |

Controller enabled is true only for literal boolean true. Host defaults `127.0.0.1`, must be nonempty and at most 255 characters. Port defaults 7443 and must be an integer 1–65535. TLS input is stored; do not assume route validation fully proves certificate/key compatibility. Empty/omitted CA clears the optional CA.

The GET route returns configured/ready flags, never secret key/certificate values. Saved configuration and active service state can differ until restart.

## Pairing and trust

| Method and relative path | Input | Success |
| --- | --- | --- |
| `GET /pairings` | None | `{ok, pairings}` |
| `POST /pairings/:gatewayId/approve` | Path ID; no body required | `{ok, pairing}` |
| `POST /pairings/:gatewayId/reject` | Path ID; no body required | `{ok, pairing}` |
| `GET /gateway-trust` | None | `{ok, gateways}` with identity/status/method flags |
| `PUT /gateway-trust/:gatewayId` | `{controllerId?, secret}` | Approved HMAC metadata; restart required |
| `DELETE /gateway-trust/:gatewayId` | Path ID | Revoked metadata; restart required |

Controller ID defaults `controller` and is nonempty, at most 255 characters. HMAC secret input must be nonempty. The trust-list route checks whether secret material exists and reports metadata, not its value.

Pairing approval requires the current live pending transcript. Controller-side trust deletion also removes pending records, clears both credential names, and invokes listener revocation. Treat these operations as administrative host-access changes.

## Gateways and operation activity

| Method and relative path | Input | Success |
| --- | --- | --- |
| `GET /gateways` | None | `{ok, gateways}` with connection/implementation/operation metadata |
| `GET /operations` | Optional `gatewayId`, `limit` query | `{ok, operations, limit}` |
| `POST /gateways/:gatewayId/processes` | Operation ID and process request | `{ok, operationId, dispatch}` |
| `POST /gateways/:gatewayId/operations/:operationId/cancel` | Path IDs | `{ok, operationId, dispatch}` |

Operation IDs match `[a-z0-9][a-z0-9._:-]{0,255}` case-insensitively. `limit` defaults 50 and is clamped to 1–256 when integral. Invalid nonintegral input selects 50. Gateway filters use gateway-ID validation.

The process route requires either a nonempty `command` or a nonempty `executable`, never both; `args` is an array of strings and cannot be nonempty with `command`. Remaining body fields are forwarded to the dispatch service. Only supply reviewed options documented in the [protocol](protocol.md).

`dispatch` contains accepted information, final response, and collected events. Inspect nested success and process evidence. Disconnected/not-ready gateway dispatch errors map to HTTP 503; other dispatch exceptions map to 400 with a code such as `gateway_dispatch_failed`.

There is no direct filesystem HTTP route in this module. Core calls `executeNativeFilesystem` through the registered execution provider.

## Core-owned assignment route

The UI also calls `PATCH /api/agents/:agentId` with an `executionEnvironment` object. That route is not implemented by Node Goblin; consult BURROW's API contract for admission and persistence. Remote assignments use kind `remote`, provider `node-goblin`, target gateway ID, and an absolute workspace root.

## Safe client behavior

Use a current authenticated BURROW session and the normal administrative UI for credential changes. Never put TLS keys, HMAC secrets, protected values, or process output into logs or URLs. Do not automatically retry a mutating process with a new ID after a timeout. [Replay and recovery](protocol.md#replay-guarantees-and-limits) explains the evidence required.

## Source references

- [`server/index.mjs`](https://github.com/NightShaman/Node-Goblin/blob/12d0f1daf74516e1f0120c80ad4716bd09e1dead/server/index.mjs)
- [`ui/settings.js`](https://github.com/NightShaman/Node-Goblin/blob/12d0f1daf74516e1f0120c80ad4716bd09e1dead/ui/settings.js)
- [`burrow.mod.json`](https://github.com/NightShaman/Node-Goblin/blob/12d0f1daf74516e1f0120c80ad4716bd09e1dead/burrow.mod.json)
