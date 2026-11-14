# Installation

Install the mod on the controller and the host runtime on each execution host. The checked-in package installer targets **Linux with systemd**. The JavaScript runtime uses Node built-ins and has no declared third-party runtime dependencies. The host package declares **Node 24.x** (`>=24 <25`) in `engines`.

!!! tip "Strongly recommended: enable Backdoor in your home Burrow"
    As part of setup, [install and enable Burrow Backdoor](https://docs.goblin-kingdom.com/burrow-backdoor/installation/) in the **Burrow instance hosting your agent**. Node Goblin routes shell and filesystem execution to your selected remote host. Backdoor keeps home-Burrow diagnostics and authorized mod administration available regardless of which execution host you select.

    This is a strong recommendation, not a required dependency. Enable Backdoor explicitly and grant administration only to trusted agents through its access settings. Backdoor does not provide arbitrary home-filesystem access or root privileges.

## Prerequisites

- A working BURROW installation that supports the Core-owned `execution-provider-v1` mod capability
- Node 24.x available to `/usr/bin/env node` for the system service
- Python 3 on the host for `node-goblin confirm-pairing`
- Linux systemd for the packaged host service
- `curl`, `tar`, `sha256sum`, and standard installation/account utilities (GNU tar is needed when building deterministic releases)
- OpenSSL on the controller if it will generate its own TLS certificate
- A hostname or IP that the gateway can reach on the controller's configured TLS port
- Permission to install packages/services and assign host execution access

## Install the BURROW mod

Install into the `mods` directory of the Burrow runtime you actually use:

```bash
BURROW_RUNTIME_ROOT="${BURROW_RUNTIME_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/burrow}"
mkdir -p "$BURROW_RUNTIME_ROOT/mods"
git clone https://github.com/GoblinKing-Burrow/Node-Goblin.git   "$BURROW_RUNTIME_ROOT/mods/node-goblin"
```

Restart BURROW to load the manifest, server entry point, and settings contribution. The manifest marks Node Goblin as a system mod and requests only `execution-provider-v1`. It does not require a separate environment grant or an extra per-agent capability approval. Core still owns authentication, agent assignment, and execution policy; system status does not grant unrelated Core access.

For a reproducible deployment, review and select a public release tag or commit before restarting. The source links in this guide track the public `main` branch; record your installed revision separately.

## Install Mini Node Goblin

Node Goblin owns the Mini Node Goblin bootstrap installer, calendar version, release archives, and checksums. BURROW does not rebuild or republish the host runtime under a BURROW version. Review the [public bootstrap installer](https://github.com/GoblinKing-Burrow/Node-Goblin/blob/main/install.sh) before running it as root:

```bash
curl -fsSL https://raw.githubusercontent.com/GoblinKing-Burrow/Node-Goblin/main/install.sh | sudo env NODE_GOBLIN_REPOSITORY=GoblinKing-Burrow/Node-Goblin sh
```

The command explicitly selects the public release repository rather than relying on the downloaded script’s default. It resolves that repository’s latest Node Goblin release, downloads the archive and checksum, verifies the checksum, and runs the package installer. To select a version, download and review the bootstrap first, then run `sudo env NODE_GOBLIN_REPOSITORY=GoblinKing-Burrow/Node-Goblin sh install.sh --version YYYY.MM.DD` with an actual published version. Optional `--controller HOST:PORT --node-id ID` values must be supplied together; they configure and connect after installation. Keep secrets out of these arguments.

For a fully reviewable selected-release installation, download the matching archive and `.sha256` from [Releases](https://github.com/GoblinKing-Burrow/Node-Goblin/releases), verify them, inspect the extracted package, and run its installer:

```bash
# Replace with the published Node Goblin version you selected.
VERSION=YYYY.MM.DD
sha256sum -c "node-goblin-$VERSION.tar.gz.sha256"
tar -xzf "node-goblin-$VERSION.tar.gz"
cd "node-goblin-$VERSION"
sudo sh deploy/install.sh
```

The checksum detects an accidental mismatch against the downloaded checksum file. It is not an independent signature or attestation of the publisher.

The package installer:

1. Validates required package assets, JavaScript syntax, runtime imports, and version metadata before replacing installed assets. Creates or adopts the `burrow` account and primary group. A newly created account uses UID 4226, is a system account, has no home created, and uses `/usr/sbin/nologin`. A newly created `burrow` group uses GID 4226; an existing `burrow` group retains its GID. A pre-existing account must have `burrow` as its primary group and may have broader access; inspect it.
2. Installs runtime content at `/opt/burrow-host-gateway`.
3. Creates `/etc/burrow-host-gateway/gateway.env` only when absent.
4. Preserves configuration and `/var/lib/burrow-host-gateway` across replacement.
5. Installs `burrow-host-gateway.service` and the `node-goblin` operator command, with `burrow-host-gateway` as a compatibility symlink.
6. Reloads systemd. On a failed package switch it attempts to restore the previous runtime and deployment assets; if rollback is incomplete it reports the retained recovery directory. It does **not** enable/start the service; `connect` performs that step.

## Configure the two sides

On BURROW, enable the controller in **Node Goblin → Controller & TLS**. Its default bind host is `127.0.0.1` and port is `7443`. Loopback is suitable only for local reachability. Choose an interface reachable from the gateway and restrict the port with your network policy. Save and restart BURROW.

On the host:

```bash
sudo node-goblin configure controller.example:7443 worker-01
sudo node-goblin connect
sudo node-goblin pairing-code
```

Use a stable gateway ID beginning with a letter or digit and containing only letters, digits, dots, underscores, or hyphens. Avoid the reserved ID `local`. The operator command accepts a wider edge case set than some controller routes; this conservative form works across the interfaces.

The newly created `burrow` account does not automatically gain access to your workspaces. Set ordinary host ownership/permissions deliberately. Paired agents can run processes and read or change files wherever that account is permitted; the configured workspace is not a sandbox.

`configure` saves settings only. To apply changes to a running daemon, drain active work and run `sudo node-goblin apply --restart`; `connect` does not restart an already-active service.

Continue with [pairing and assignment](pairing.md). `connect` reporting an active systemd service proves the daemon is running, not that pairing or remote execution succeeded.

## Burrow in Docker: run Node Goblin on the host

For agents that need to work on the Docker host, we recommend installing the Node Goblin host runtime **natively on that host**, while keeping Burrow in its container. This provides an explicit host execution target instead of bind-mounting the host root into Burrow or making the Burrow container privileged merely to reach host files.

When the native host runtime and the Burrow container are on the **same machine**, configure Node Goblin to connect to **`localhost:7443`**:

```bash
sudo node-goblin configure localhost:7443 docker-host
sudo node-goblin connect
sudo node-goblin pairing-code
```

Here `docker-host` is an example stable gateway ID. Run these commands on the host, not inside the Burrow container. For an already-running daemon, apply changed configuration with `sudo node-goblin apply --restart` after draining active work.

Make the controller reachable from that host:

- **Ordinary Docker bridge networking:** enable the Host Gateway controller, bind its listener to `0.0.0.0:7443` **inside the container**, and publish container port 7443 to the host. For same-host-only nodes, add `"127.0.0.1:7443:7443"` beside the existing web-port entry under `ports`. Recreate the container after changing Compose port mappings. A controller bound only to container `127.0.0.1` is not reachable through a bridge port mapping.
- **Linux host networking:** the container shares the host network namespace, so a controller bound to `127.0.0.1:7443` can accept the native host runtime directly; Docker `ports` mappings are not used in this mode.
- **Other machines:** `localhost` refers to each node's own machine. Remote nodes need a reachable controller hostname/address and deliberate network access, not `localhost`. A loopback-only published port does not serve remote nodes.

The Host Gateway controller port is separate from Burrow's web interface. If `localhost` resolves to an unavailable IPv6 loopback listener, use `127.0.0.1:7443` for the IPv4 mapping above.

Compare the current pairing code independently, confirm it on the host with `sudo node-goblin confirm-pairing CODE` when using first no-CA trust, and approve the matching live request in Burrow. Then assign the agent's **Configured gateway** execution target to this gateway and choose a workspace path on the host. Leaving the agent on **Local controller** still executes inside Burrow's container. See [pairing and assignment](pairing.md).

Host execution uses the native service account's permissions; a workspace path is not a sandbox. Grant only the host files and commands needed. This arrangement does not require a host-root mount or Docker socket mount in Burrow. Giving the host runtime access to Docker itself is a separate, powerful permission decision. Restarting Burrow interrupts its controller connection, so keep a local or SSH recovery route for maintenance.

## Non-privileged staging test

Use a fresh temporary root to inspect installation output without touching the host's real service or accounts:

```bash
stage=$(mktemp -d)
sh gateway/deploy/install.sh --root "$stage" --skip-account --no-systemd
BURROW_GATEWAY_ROOT="$stage" "$stage/usr/local/bin/node-goblin" configure controller.example:7443 worker-01
```

Staging intentionally avoids account ownership changes. `connect`/`apply` refuse service operations under a staging root unless an explicit test `SYSTEMCTL` override is provided; `status` always refuses a staging root. Do not remove a staging folder until you have confirmed its path and that you no longer need it.

## Update or uninstall

For the mod, `git pull --ff-only` updates a clean checkout; then restart BURROW. Review the incoming revision first. For the host package, drain work and preserve a protected backup, then run `sudo env NODE_GOBLIN_REPOSITORY=GoblinKing-Burrow/Node-Goblin sh install.sh --update` with the reviewed bootstrap, or `sudo sh deploy/update.sh` from the selected verified release archive. Both install and restart together; verify controller connection and an operation afterward. Run locally or over SSH, not through the service being updated. See [operations](operations.md).

`sudo node-goblin uninstall` removes runtime files, command links, and the unit. It preserves the account, configuration, identity/trust, and journal for reinstall. It is not a credential purge.

## Source references

- [`README.md`](https://github.com/GoblinKing-Burrow/Node-Goblin/blob/main/README.md)
- [`gateway/deploy/install.sh`](https://github.com/GoblinKing-Burrow/Node-Goblin/blob/main/gateway/deploy/install.sh)
- [`gateway/deploy/burrow-host-gateway.service`](https://github.com/GoblinKing-Burrow/Node-Goblin/blob/main/gateway/deploy/burrow-host-gateway.service)
- [`gateway/package.json`](https://github.com/GoblinKing-Burrow/Node-Goblin/blob/main/gateway/package.json)

## Automatic operating skill

On compatible Core and mod builds that declare managed skills, loading this mod automatically supplies the `node-goblin-operations` skill from [Burrow-Skills](https://github.com/GoblinKing-Burrow/Burrow-Skills/tree/main/node-goblin-operations). Core maintains the installed copy as read-only and refreshes managed skills at startup, on mod lifecycle changes, and on its default six-hour schedule. You do not paste, edit, or assign that managed copy manually. The skill provides instructions; it does not grant tool or data access.

The current mod manifest declares this managed skill. Automatic mod-managed delivery still requires a Core build that supports it. Older public **2026.10.19** snapshots lack the declaration; updating only the skill repository cannot add the missing integration to those older packages. See [how managed skills work](https://docs.goblin-kingdom.com/burrow-skills/managed-skills/).
