# Remote Nodes for Burrow

Remote Nodes is a small Burrow mod that stores additional Burrow API targets. Core Burrow uses those targets through its existing UI, API client, chat streaming, sessions, tools, settings, and other product surfaces.

The mod does not reimplement Burrow screens or proxy Burrow APIs. Version 1 stores only:

```text
id
name
baseUrl
enabled
```

Target records live in the mod's namespace in Burrow's existing SQLite settings database.

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

## Contract

The manifest contributes one host-owned API-target endpoint and a declarative Settings slot. Core owns the Settings layout and rendering; this mod only declares metadata and requests the host-owned `apiTargets` capability:

```json
{
  "contributions": {
    "apiTargets": "/api/mods/remote-nodes/targets",
    "settings": [{
      "id": "remote-targets",
      "navigation": { "title": "Remote Nodes", "description": "Configure remote Burrow nodes." },
      "primary": { "title": "Connection", "capability": "apiTargets" },
      "inventory": {
        "title": "Known nodes",
        "capability": "apiTargets",
        "emptyState": { "title": "No remote nodes", "description": "Add one to begin." }
      }
    }]
  }
}
```

The `navigation` metadata is rendered in Column 2, `primary` in Column 3, and optional `inventory` in Column 4. Mods do not provide markup, styles, layout instructions, or executable UI behavior.

The endpoint supports:

```text
GET    /api/mods/remote-nodes/targets
POST   /api/mods/remote-nodes/targets
PUT    /api/mods/remote-nodes/targets/:id
DELETE /api/mods/remote-nodes/targets/:id
```

Core Burrow renders target settings, combines resources from enabled targets, preserves node provenance, and routes operations to the node that owns each resource.

Remote Burrow APIs must be reachable by the browser. Burrow core provides CORS for its API routes. Version 1 adds no remote credential contract.

## Test

```bash
node --test server/index.test.mjs
```
