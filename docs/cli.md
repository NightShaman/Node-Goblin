# Command reference

*On narrow screens, swipe tables horizontally to see every column.*

There are two command surfaces. The installed shell command manages a systemd service. The JavaScript CLI starts the daemon directly.

## Installed operator command

| Command | Effect |
| --- | --- |
| `sudo node-goblin configure [CONTROLLER_ADDRESS NODE_ID]` | Prompts for omitted non-secret values; writes endpoint and ID; preserves other config |
| `sudo node-goblin connect` | Reloads systemd, enables/starts service, verifies active state, prints current pairing code when readable; does not restart an active daemon |
| `sudo node-goblin apply --restart` | Enables and explicitly restarts the service to apply saved settings; drain work first |
| `sudo node-goblin confirm-pairing CODE` | Checks the current local code and writes host confirmation for that connection; compare independently before running |
| `sudo node-goblin status` | Displays systemd status and readable pending code |
| `sudo node-goblin pairing-code` | Displays pending gateway ID/code; nonzero if none is readable |
| `sudo node-goblin unpair` | Stops service and removes controller trust/pins; keeps node keypair/journal |
| `sudo node-goblin uninstall` | Removes executable package/unit; preserves configuration/account/state |
| `node-goblin help` | Prints usage |

`configure` accepts `tls://host:port` or `host:port`; other URL schemes are rejected. Prefer conservative DNS names or verified IP forms and a gateway ID beginning with a letter or digit. It saves configuration without applying it to a running daemon and does not test network reachability or certificate validity. `connect` does not prove authentication or operation success.

The operator command requires root for mutations when operating on `/`. It supports a staging root for filesystem-only test operations. `connect` and `apply` require an explicit test `SYSTEMCTL` override there; `status` always refuses a staging root. Existing scripts can call the `burrow-host-gateway` symlink.

State-related wrapper commands always use `/var/lib/burrow-host-gateway` beneath the selected root. They do not follow a daemon `BURROW_GATEWAY_STATE_DIR` override; see [configuration](configuration.md#gateway-environment).

## Direct daemon

```bash
node gateway/node-goblin.mjs
# Compatibility entry:
node gateway/cli.mjs
```

With `BURROW_GATEWAY_CONTROLLER_URL` absent, the daemon uses stdin/stdout JSON lines. With it present, it requires a `tls:` URL, state directory, and gateway ID, then starts outbound TLS transport. Standard error is used for pairing status; standard output belongs to the stdio protocol when that mode is active.

The JavaScript entry point does not parse the shell wrapper's subcommands or provide a separate `--version` argument. Check release metadata and the protocol `hello` response as distinct evidence sources.

## Bootstrap installer

The repository-root `install.sh` downloads and verifies a Node Goblin release, then calls its package installer:

```text
install.sh [--version YYYY.MM.DD[.N]] [--controller HOST:PORT] [--node-id ID] [--update]
```

It requires root, `curl`, `tar`, and `sha256sum`. Version defaults to `latest`; controller and node ID must be supplied together and trigger configure/connect after installation. `NODE_GOBLIN_VERSION` selects a default version and `NODE_GOBLIN_REPOSITORY` overrides the release repository. Use the official public repository unless you have explicitly reviewed another publisher. See [installation](installation.md#install-mini-node-goblin).

`--update` invokes the downloaded package's `deploy/update.sh`: an existing configured host is upgraded and its service restarted. It cannot be combined with `--controller` or `--node-id`, because updates preserve configuration. Drain work first and run from a local/SSH terminal, not through the service being replaced.

## Package installer and uninstaller scripts

```text
install.sh [--root DIRECTORY] [--source DIRECTORY] [--no-systemd] [--skip-account] [--restart]
update.sh [--source DIRECTORY]
uninstall.sh [--root DIRECTORY] [--no-systemd]
```

`deploy/update.sh` requires an existing configured installation and invokes the transactional installer with `--restart`. It stops and verifies the old service before replacing files, checks the restarted service, and attempts package/service rollback on failure. Active state is not controller/execution verification.

A non-root staging installation must use `--root` and `--skip-account`. `--source` identifies the package's gateway-root source directory. Use `--no-systemd` for staging; production use should preserve service lifecycle management.

## Release tools

`gateway/deploy/build-release.sh [OUTPUT_DIRECTORY]` creates `node-goblin-<VERSION>.tar.gz` and its SHA-256 file. `SOURCE_DATE_EPOCH` defaults to zero if not supplied. `gateway/deploy/set-release-version.mjs VERSION [--check]` synchronizes or checks the manifest, package version, and `gateway/VERSION`; accepted version shape is `YYYY.MM.DD[.N]`.

See [development](development.md) for test/build commands and current release automation.

## Source references

- [`install.sh`](https://github.com/GoblinKing-Burrow/Node-Goblin/blob/main/install.sh)
- [`gateway/deploy/node-goblin`](https://github.com/GoblinKing-Burrow/Node-Goblin/blob/main/gateway/deploy/node-goblin)
- [`gateway/cli.mjs`](https://github.com/GoblinKing-Burrow/Node-Goblin/blob/main/gateway/cli.mjs)
- [`gateway/deploy/install.sh`](https://github.com/GoblinKing-Burrow/Node-Goblin/blob/main/gateway/deploy/install.sh)
- [`gateway/deploy/uninstall.sh`](https://github.com/GoblinKing-Burrow/Node-Goblin/blob/main/gateway/deploy/uninstall.sh)
- [`gateway/deploy/build-release.sh`](https://github.com/GoblinKing-Burrow/Node-Goblin/blob/main/gateway/deploy/build-release.sh)
- [`gateway/deploy/set-release-version.mjs`](https://github.com/GoblinKing-Burrow/Node-Goblin/blob/main/gateway/deploy/set-release-version.mjs)
