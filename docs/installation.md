# Installation

Install the mod on the controller and the host runtime on each execution host. The checked-in package installer targets **Linux with systemd**. The JavaScript runtime uses Node built-ins and has no declared third-party runtime dependencies. Release CI uses **Node 24**; the repository does not declare a minimum supported Node version in `engines`.

## Prerequisites

- A working BURROW installation that supports the Core-owned `execution-provider-v1` mod capability
- Node available to `/usr/bin/env node` for the system service
- Linux systemd for the packaged host service
- `tar`, GNU tar for deterministic release builds, and standard installation/account utilities
- OpenSSL on the controller if it will generate its own TLS certificate
- A hostname or IP that the gateway can reach on the controller's configured TLS port
- Permission to install packages/services and assign host execution access

## Install the BURROW mod

The upstream README uses the BURROW runtime's `mods` directory:

```bash
BURROW_RUNTIME_ROOT="${BURROW_RUNTIME_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/burrow}"
mkdir -p "$BURROW_RUNTIME_ROOT/mods"
git clone https://github.com/NightShaman/Node-Goblin.git   "$BURROW_RUNTIME_ROOT/mods/node-goblin"
```

Restart BURROW to load the manifest, server entry point, and settings contribution. The manifest declares `execution-provider-v1`; it does not require a separate environment grant for that capability. Whether a particular BURROW deployment admits the installed mod remains a Core responsibility.

For a reproducible deployment, review and select a tag or commit before restarting. This guide's baseline is `12d0f1daf74516e1f0120c80ad4716bd09e1dead`.

## Install Mini Node Goblin

The repository README points to BURROW's wrapper installer. That wrapper is maintained in the BURROW repository and can change independently. For a reviewable installation, download a selected Node Goblin release archive and its matching `.sha256` from [Releases](https://github.com/NightShaman/Node-Goblin/releases), verify them, extract, and run the package installer:

```bash
# Example release filename; select the version you intend to install.
sha256sum -c node-goblin-2026.09.27.tar.gz.sha256
tar -xzf node-goblin-2026.09.27.tar.gz
cd node-goblin-2026.09.27
sudo sh deploy/install.sh
```

The checksum detects an accidental mismatch against the downloaded checksum file. It is not an independent signature or attestation of the publisher.

The package installer:

1. Creates or adopts the `burrow` account and primary group. A newly created account uses UID 4226, is a system account, has no home created, and uses `/usr/sbin/nologin`. A newly created `burrow` group uses GID 4226; an existing `burrow` group retains its GID. A pre-existing account must have `burrow` as its primary group and may have broader access; inspect it.
2. Installs runtime content at `/opt/burrow-host-gateway`.
3. Creates `/etc/burrow-host-gateway/gateway.env` only when absent.
4. Preserves configuration and `/var/lib/burrow-host-gateway` across replacement.
5. Installs `burrow-host-gateway.service` and the `node-goblin` operator command, with `burrow-host-gateway` as a compatibility symlink.
6. Reloads systemd. It does **not** enable/start the service; `connect` performs that step.

## Configure the two sides

On BURROW, enable the controller in **Node Goblin → Controller & TLS**. Its default bind host is `127.0.0.1` and port is `7443`. Loopback is suitable only for local reachability. Choose an interface reachable from the gateway and restrict the port with your network policy. Save and restart BURROW.

On the host:

```bash
sudo node-goblin configure controller.example:7443 worker-01
sudo node-goblin connect
sudo node-goblin pairing-code
```

Use a stable gateway ID beginning with a letter or digit and containing only letters, digits, dots, underscores, or hyphens. Avoid the reserved ID `local`. The operator command accepts a wider edge case set than some controller routes; this conservative form works across the interfaces.

Continue with [pairing and assignment](pairing.md). `connect` reporting an active systemd service proves the daemon is running, not that pairing or remote execution succeeded.

## Non-privileged staging test

Use a fresh temporary root to inspect installation output without touching the host's real service or accounts:

```bash
stage=$(mktemp -d)
sh gateway/deploy/install.sh --root "$stage" --skip-account --no-systemd
BURROW_GATEWAY_ROOT="$stage" "$stage/usr/local/bin/node-goblin" configure controller.example:7443 worker-01
```

Staging intentionally avoids account ownership changes. `connect` and `status` refuse to operate under a staging root. Do not remove a staging folder until you have confirmed its path and that you no longer need it.

## Update or uninstall

For the mod, `git pull --ff-only` updates a clean checkout; then restart BURROW. Review the incoming revision first. For the host package, stop the service, preserve a protected backup, install the selected replacement, and start/verify it. See [operations](operations.md).

`sudo node-goblin uninstall` removes runtime files, command links, and the unit. It preserves the account, configuration, identity/trust, and journal for reinstall. It is not a credential purge.

## Source references

- [`README.md`](https://github.com/NightShaman/Node-Goblin/blob/12d0f1daf74516e1f0120c80ad4716bd09e1dead/README.md)
- [`gateway/deploy/install.sh`](https://github.com/NightShaman/Node-Goblin/blob/12d0f1daf74516e1f0120c80ad4716bd09e1dead/gateway/deploy/install.sh)
- [`gateway/deploy/burrow-host-gateway.service`](https://github.com/NightShaman/Node-Goblin/blob/12d0f1daf74516e1f0120c80ad4716bd09e1dead/gateway/deploy/burrow-host-gateway.service)
- [`gateway/package.json`](https://github.com/NightShaman/Node-Goblin/blob/12d0f1daf74516e1f0120c80ad4716bd09e1dead/gateway/package.json)
