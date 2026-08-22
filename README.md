# Remote Nodes for Burrow

Remote Nodes is a small Burrow mod that contributes additional Burrow API targets to the existing core UI.

The mod owns only this node registry:

```text
id, name, baseUrl, enabled
```

Burrow core owns agents, sessions, settings, chat, streaming, cancellation, tools, memory, receipts, rendering, and request routing. The mod does not copy or replace those systems.

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

## State

Target records are stored in the `remote-nodes` namespace of Burrow's existing SQLite settings database. The package has no separate database and stores no credentials in version one.

Remote targets are contacted directly by the existing Burrow UI client. Their APIs must be reachable from the browser and allow the UI origin through CORS.

## Update

```bash
git -C "$BURROW_RUNTIME_ROOT/mods/remote-nodes" pull --ff-only
```

Restart Burrow after updating.

## Test

```bash
node --test server/index.test.mjs
```
