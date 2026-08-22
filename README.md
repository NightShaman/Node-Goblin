# Remote Nodes for Burrow

Remote Nodes is a standalone Burrow mod for configuring and checking other Burrow installations from a UI-enabled Burrow node.

## Install

Choose the runtime root used by your Burrow installation, then clone this repository into its `mods` directory:

```bash
BURROW_RUNTIME_ROOT="${BURROW_RUNTIME_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/burrow}"
mkdir -p "$BURROW_RUNTIME_ROOT/mods"
git clone https://github.com/NightShaman/burrow-mod-remote-nodes.git \
  "$BURROW_RUNTIME_ROOT/mods/remote-nodes"
```

Restart Burrow after installing or updating the mod.

Other common runtime roots include `/var/lib/burrow` for a system installation and `/data` in Docker.

## Update

```bash
git -C "$BURROW_RUNTIME_ROOT/mods/remote-nodes" pull --ff-only
```

Restart Burrow after updating.

## State and credentials

The package directory contains only mod code and UI assets. Node configuration is stored in Burrow's SQLite settings database. Remote-node credentials are stored through Burrow's encrypted mod-secret storage and are never returned to the UI.

## Test

```bash
node --test server/index.test.mjs
```
