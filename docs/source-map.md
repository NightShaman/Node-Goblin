# Source map and coverage

*On narrow screens, swipe tables horizontally to see every column.*

These docs were prepared against **NightShaman/Node-Goblin** main commit **`12d0f1daf74516e1f0120c80ad4716bd09e1dead`**, verified 2026-10-03 UTC, release metadata **2026.09.27**. Documentation-only changes do not change that runtime baseline.

The repository has 41 tracked baseline files, including one image asset, tests, release automation, and metadata. The runtime implementation is small enough to map directly. No `AGENTS.md` or repository `.agents/skills` files were present in this snapshot.

## Implementation coverage

| Source | Documentation |
| --- | --- |
| `burrow.mod.json`, `README.md` | [Overview](index.md), [installation](installation.md), [architecture](architecture.md) |
| `server/index.mjs` | [HTTP API](api.md), [settings](settings.md), [configuration](configuration.md), [architecture](architecture.md) |
| `ui/settings.js`, `ui/package.json` | [Settings](settings.md), [pairing and assignment](pairing.md), [API](api.md) |
| `gateway/cli.mjs`, `node-goblin.mjs`, `index.mjs`, `package.json` | [CLI](cli.md), [configuration](configuration.md), [development](development.md) |
| `gateway/lib/controller-listener.mjs` | [Architecture](architecture.md), [protocol](protocol.md), [pairing](pairing.md), [operations](operations.md) |
| `gateway/lib/network-transport.mjs`, `pairing.mjs` | [Pairing](pairing.md), [security](security.md), [configuration](configuration.md) |
| `gateway/lib/daemon.mjs`, `client.mjs`, `protocol.mjs` | [Wire protocol](protocol.md), [CLI](cli.md) |
| `gateway/lib/process-runner.mjs` | [Process execution](protocol.md), [security](security.md) |
| `gateway/lib/filesystem-runner.mjs` | [Native filesystem operations](filesystem.md) |
| `gateway/lib/journal.mjs` | [Replay](protocol.md#replay-guarantees-and-limits), [operations](operations.md), [configuration](configuration.md) |
| `gateway/deploy/*`, `gateway/VERSION` | [Installation](installation.md), [CLI](cli.md), [configuration](configuration.md), [development](development.md) |
| `.github/workflows/release-node-goblin.yml` | [Releases](development.md#release-behavior) |
| Tests under `gateway`, `server`, `ui` | [Development and test matrix](development.md) |
| `NG-Logo.png`, `.gitignore` | Project asset and repository housekeeping |

## Scope and limits

The BURROW Core implementation, its authentication/secret storage, and the wrapper installer hosted in BURROW are separate source boundaries. This guide explains the interfaces used here without claiming an audit of a deployed BURROW installation or a remote host.

Known semantics important to integrations include bounded completed replay, an independent HTTP target collection, future-turn Core assignments, account-level host access, and separate transport/tool success. The guide intentionally does not promise exactly-once execution, a workspace sandbox, automated TLS rotation, pairing expiry, or a supported Node minimum absent a repository declaration.

Release metadata and protocol-reported implementation version are separate code paths in this baseline. Inspect the selected source files rather than treating one display field as proof of installed provenance.

## Maintaining the source links

Each page links to its principal sources at the pinned baseline. Update links and behavior together when reviewing a new runtime revision. Public documentation should retain source-grounded operational guidance; detailed security investigation artifacts should follow the project's disclosure process.

## Source references

- [`burrow.mod.json`](https://github.com/NightShaman/Node-Goblin/blob/12d0f1daf74516e1f0120c80ad4716bd09e1dead/burrow.mod.json)
- [`gateway/VERSION`](https://github.com/NightShaman/Node-Goblin/blob/12d0f1daf74516e1f0120c80ad4716bd09e1dead/gateway/VERSION)
- [`gateway/package.json`](https://github.com/NightShaman/Node-Goblin/blob/12d0f1daf74516e1f0120c80ad4716bd09e1dead/gateway/package.json)
