# Source and coverage

This guide covers the public **2026.10.19** release of [GoblinKing-Burrow/Node-Goblin](https://github.com/GoblinKing-Burrow/Node-Goblin/tree/0ff5f7ee03624aa8a2e7d19a492fdb871f4e698d), reviewed on 19 October 2026. Documentation-only updates do not change that runtime baseline.

## What was checked

The installation, pairing, settings, configuration, command, and recovery instructions were checked against the published installer, service unit, host wrapper, gateway runtime, controller server, and settings contribution. Source links in individual reference pages point to the public repository's current files; use the [reviewed release snapshot](https://github.com/GoblinKing-Burrow/Node-Goblin/tree/0ff5f7ee03624aa8a2e7d19a492fdb871f4e698d) when comparing exact behavior.

| Source | Guide |
| --- | --- |
| `install.sh`, `gateway/deploy/` | [Installation](installation.md), [commands](cli.md), [operations](operations.md) |
| `burrow.mod.json`, `ui/settings.js` | [Settings](settings.md), [pairing and assignments](pairing.md) |
| `server/index.mjs` | [HTTP API](api.md), [configuration](configuration.md), [architecture](architecture.md) |
| `gateway/cli.mjs` and `gateway/lib/network-transport.mjs` | [Configuration](configuration.md), [pairing](pairing.md), [security](security.md) |
| `gateway/lib/controller-listener.mjs` and `pairing.mjs` | [Pairing](pairing.md), [architecture](architecture.md), [operations](operations.md) |
| `gateway/lib/daemon.mjs`, `protocol.mjs`, `client.mjs`, `journal.mjs` | [Wire protocol](protocol.md), [recovery](operations.md) |
| `gateway/lib/process-runner.mjs` and `filesystem-runner.mjs` | [Security](security.md), [filesystem](filesystem.md), [protocol](protocol.md) |
| Gateway, server, UI, and deployment tests | [Development](development.md) |

## What this does not prove

A source review and documentation build do not establish that your network, certificates, service account, or Burrow installation are configured correctly. Verify a new host with a harmless operation in a disposable workspace.

Burrow owns the mod lifecycle, authenticated API hosting, agent assignments, and tool routing. This repository supplies the execution provider and host transport. It does not provide an operating-system sandbox or a blanket safety guarantee around agent actions.

Operations may continue after a transport failure. Replay and retention are bounded, and a new operation ID can repeat a side effect. Follow the recovery instructions before retrying uncertain work.

Public release versions use `YYYY.MM.DD`. The wire protocol version is a separate compatibility identifier. Check the installed package and host status rather than treating a docs date as proof of what a machine is running.
