# Installation

Install the mod on the controller and the host runtime on each execution host. The checked-in package installer targets **Linux with systemd**. The JavaScript runtime uses Node built-ins and has no declared third-party runtime dependencies. The host package declares **Node 24.x** (`>=24 <25`) in `engines`.

!!! tip "Strongly recommended: enable Backdoor in your home Burrow"
    As part of setup, [install and enable Burrow Backdoor](https://burrow-docs.blissful-psychosis.com/burrow-backdoor/installation/) in the **Burrow instance hosting your agent**. Node Goblin routes shell and filesystem execution to your selected remote host. Backdoor keeps home-Burrow diagnostics and authorized mod administration available regardless of which execution host you select.

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
curl -fsSL https://raw.githubusercontent.com/GoblinKing-Burrow/Node-Goblin/main/install.sh | sudo sh
```

By default, it resolves the latest Node Goblin release, downloads the archive and checksum, verifies the checksum, and runs the package installer. To select a version, download and review the bootstrap first, then run `sudo sh install.sh --version YYYY.MM.DD` with an actual published version. Optional `--controller HOST:PORT --node-id ID` values must be supplied together; they configure and connect after installation. Keep secrets out of these arguments.

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

## Non-privileged staging test

Use a fresh temporary root to inspect installation output without touching the host's real service or accounts:

```bash
stage=$(mktemp -d)
sh gateway/deploy/install.sh --root "$stage" --skip-account --no-systemd
BURROW_GATEWAY_ROOT="$stage" "$stage/usr/local/bin/node-goblin" configure controller.example:7443 worker-01
```

Staging intentionally avoids account ownership changes. `connect`/`apply` refuse service operations under a staging root unless an explicit test `SYSTEMCTL` override is provided; `status` always refuses a staging root. Do not remove a staging folder until you have confirmed its path and that you no longer need it.

## Update or uninstall

For the mod, `git pull --ff-only` updates a clean checkout; then restart BURROW. Review the incoming revision first. For the host package, stop the service, preserve a protected backup, install the selected replacement, and start/verify it. See [operations](operations.md).

`sudo node-goblin uninstall` removes runtime files, command links, and the unit. It preserves the account, configuration, identity/trust, and journal for reinstall. It is not a credential purge.

## Source references

- [`README.md`](https://github.com/GoblinKing-Burrow/Node-Goblin/blob/main/README.md)
- [`gateway/deploy/install.sh`](https://github.com/GoblinKing-Burrow/Node-Goblin/blob/main/gateway/deploy/install.sh)
- [`gateway/deploy/burrow-host-gateway.service`](https://github.com/GoblinKing-Burrow/Node-Goblin/blob/main/gateway/deploy/burrow-host-gateway.service)
- [`gateway/package.json`](https://github.com/GoblinKing-Burrow/Node-Goblin/blob/main/gateway/package.json)

## Automatic operating skill

On compatible Core and mod builds that declare managed skills, loading this mod automatically supplies the `node-goblin-operations` skill from [Burrow-Skills](https://github.com/GoblinKing-Burrow/Burrow-Skills/tree/main/node-goblin-operations). Core maintains the installed copy as read-only and refreshes managed skills at startup, on mod lifecycle changes, and on its default six-hour schedule. You do not paste, edit, or assign that managed copy manually. The skill provides instructions; it does not grant tool or data access.

The public **2026.10.19** mod snapshot does not yet declare this managed skill. Automatic mod-managed delivery requires both the newer manifest and a Core build that supports it; updating only the skill repository cannot add the missing integration. See [how managed skills work](https://burrow-docs.blissful-psychosis.com/burrow-skills/managed-skills/).
