# Node Goblin

<p align="center">
  <img src="NG-Logo.png" alt="Node Goblin" width="480">
</p>

Node Goblin is the Burrow mod for connecting and managing additional Burrow nodes.

This repository also contains **Mini Node Goblin**, the small host runtime that runs on a node and connects back to Burrow. “Mini” is only a differentiator; it does not describe a separate protocol or implementation.

## Install the mod

Install the mod into the `mods` directory of a Burrow runtime:

```bash
BURROW_RUNTIME_ROOT="${BURROW_RUNTIME_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/burrow}"
mkdir -p "$BURROW_RUNTIME_ROOT/mods"
git clone https://github.com/NightShaman/Node-Goblin.git \
  "$BURROW_RUNTIME_ROOT/mods/node-goblin"
```

Grant the mod the Core-owned execution-provider capability in Burrow's runtime environment:

```bash
BURROW_SYSTEM_MOD_CAPABILITIES='{"node-goblin":"execution-provider-v1"}'
```

Merge this entry with any existing capability grants rather than replacing them. Node Goblin declares the capability in its manifest, but Core grants privileged capabilities only through operator-owned runtime configuration.

Restart Burrow after installing, updating, or changing the grant.

To update an existing checkout:

```bash
git -C "$BURROW_RUNTIME_ROOT/mods/node-goblin" pull --ff-only
```

## Mini Node Goblin

Install Mini Node Goblin on the host you want Burrow to reach:

```bash
curl -fsSL https://raw.githubusercontent.com/NightShaman/Burrow/main/install-node-goblin.sh | sudo sh
```

The installer sets up the host runtime and service. Follow its instructions to configure and connect it to Burrow.

## Links

- [Burrow](https://github.com/NightShaman/Burrow)
- [Releases](https://github.com/NightShaman/Node-Goblin/releases)
- [Issues](https://github.com/NightShaman/Node-Goblin/issues)
