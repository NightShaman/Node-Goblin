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

Node Goblin declares the Core-owned `execution-provider-v1` capability in its installed manifest. No separate environment grant is required.

Restart Burrow after installing or updating the mod.

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

### Filesystem traversal evidence

Mini Node Goblin defaults to depth 4 for listings and 8 for find/search,
500 returned entries/paths, and 200 search matches. Explicit positive tool
bounds override these defaults; omitted/null bounds select defaults rather
than one entry. Find/search traversal uses a 4,000-entry resource budget to
bound recursive memory/work, configurable with
`BURROW_FILESYSTEM_TRAVERSAL_ENTRIES` (positive integer) on the gateway host.
Results distinguish `depthTruncated`, `entryBudgetExhausted`, and `truncated`;
unreadable entries produce warnings and `incomplete`, never a complete-map
claim. Result limits do not imply that an empty match set searched every path.
