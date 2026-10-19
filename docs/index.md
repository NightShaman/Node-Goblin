<div class="burrow-hero" markdown>

![Node Goblin](assets/hero.png){ .node-goblin-hero-art }

# Put your agents to work on your machines.

Node Goblin connects Burrow to remote execution hosts. Pair a host, choose an agent, and let it run commands and work with files there.

[Install Node Goblin](installation.md){ .md-button .md-button--primary }
[Pair your first host](pairing.md){ .md-button }

Public-release guide · **2026.10.19**

</div>

!!! danger "Node Goblin gives agents real access to your host."
    **This is not a safe sandbox.** Agents can execute commands and read, change, or delete files with the permissions of the host service account. Commands can reach other systems and services accessible to that account. A workspace path does not contain that access. Use a disposable or deliberately restricted host, protect credentials, and pair only controllers you trust. Do not rely on an extra approval prompt to prevent damage.

## Two pieces. One connection.

- **Node Goblin** is the mod on your Burrow controller. It manages the listener, host pairing, and agent assignments.
- **Mini Node Goblin** is the runtime on each execution host. It connects outbound to the controller over TLS. You do not need a full Burrow installation on that host.

The packaged host installer supports **Linux with systemd**, **Node.js 24.x**, and **Python 3** for confirming a pairing. Start with a host you can safely experiment on.

<div class="grid cards" markdown>

- **Connect your first host**

    Install the controller mod and host service, then compare and confirm the pairing code on both sides.

    [Installation →](installation.md)

- **Choose where an agent works**

    Assign an approved host and an absolute workspace path. Verify a harmless operation in a new turn.

    [Pairing and assignments →](pairing.md)

- **Keep the connection healthy**

    Check service and host status, apply saved configuration, update deliberately, and recover from interrupted work.

    [Operations and troubleshooting →](operations.md)

- **Understand the access you grant**

    Learn what pairing protects, what the service account can do, and why disconnecting is not proof that work stopped.

    [Security and trust →](security.md)

</div>

## Before you start

You need a working [Burrow installation](https://burrow-docs.blissful-psychosis.com/), permission to install a host service, and a controller address reachable from that host. The listener starts **disabled** and defaults to **127.0.0.1:7443**. Remote hosts need a reachable interface and an appropriately restricted firewall rule.

Installing an API target is separate from pairing an execution host. For agent execution, use an approved gateway in **Agent assignments**. The [settings guide](settings.md) explains each section.

## Reference and help

- [Configuration](configuration.md) and [operator commands](cli.md)
- [Architecture](architecture.md), [filesystem behavior](filesystem.md), [HTTP API](api.md), and [wire protocol](protocol.md)
- [Source and verification scope](source-map.md)
- [Public repository](https://github.com/GoblinKing-Burrow/Node-Goblin), [releases](https://github.com/GoblinKing-Burrow/Node-Goblin/releases), and [issues](https://github.com/GoblinKing-Burrow/Node-Goblin/issues)

Node Goblin is distributed under its [Sustainable Use License](https://github.com/GoblinKing-Burrow/Node-Goblin/blob/main/LICENSE).
