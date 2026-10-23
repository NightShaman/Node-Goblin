# Operations and recovery

*On narrow screens, swipe tables horizontally to see every column.*

Operate Node Goblin as a host-execution service. Check service health, controller connection, trust, and actual operation evidence separately.

## First verification

1. Check `sudo node-goblin status` and `sudo journalctl -u burrow-host-gateway.service -n 100 --no-pager` on the host.
2. Confirm the controller's current listener configuration and that the chosen port is reachable under your network policy.
3. Compare the current pairing code, confirm it locally when required, and approve the matching live request.
4. Confirm approved/connected state in BURROW.
5. Assign a test agent to a disposable absolute workspace and run a harmless read-only operation.
6. Check returned host identity, working directory, exit status, and target/operation IDs. A generic active status alone is insufficient.

Protect logs before sharing them. Pairing logs contain pairing codes; process results and filesystem journals can contain private content.

## Troubleshooting

| Symptom | Check | Safe next step |
| --- | --- | --- |
| Service will not start | Node path, readable env/state/TLS files, service account, journal JSON | Read service logs; correct the identified configuration problem |
| Service active, no controller connection | Endpoint/DNS/port, outbound network, controller bind interface | Verify both ends; service-active is only local process state |
| Saved host settings have no effect | `configure` only writes the environment file; `connect` does not restart an active service | Drain active work, then run `sudo node-goblin apply --restart` |
| Unpair/uninstall refuses to proceed | Service stop result and reported active state | Resolve the service-state problem; do not manually delete trust/runtime to bypass the check |
| Controller appears disabled | Saved enabled flag and restart | Save desired settings and restart BURROW |
| TLS generation failed | OpenSSL availability and controller secret storage | Supply reviewed TLS material or restore required tooling/storage |
| Certificate/identity mismatch | Current controller key/cert vs host's saved trust | Investigate unexpected change; do not bypass trust checks blindly |
| Pending request cannot be approved | Current node connection/nonce vs persisted pending record | Reconnect and compare the fresh code |
| Gateway already connected | Duplicate gateway ID or cloned state | Stop the unintended duplicate; preserve independent host identities |
| `gateway_not_connected` / `gateway_not_ready` | Connection and approval state | Establish trusted connection before execution |
| `gateway_disconnected` during work | Host-side operation and journal | Treat outcome as uncertain; inspect before retry |
| `operation_in_progress` | Same operation still running | Wait or request cancellation; do not assign a new ID to force duplicate work |
| `operation_id_conflict` | Changed command/tool/options under reused ID | Correct correlation; use a new ID only for intentionally new work |
| `protected_redelivery_forbidden` | Protected values resent for retained operation | Do not blindly replay one-shot secret delivery |
| Empty/incomplete filesystem results | Bounds, skipped entries, warnings, permissions | Report the searched scope; enlarge only the necessary bounds |
| Version in UI differs from release file | Runtime `hello` identity vs manifest/VERSION | Verify installed files and release SHA separately |

## Disconnect and cancellation

A TCP/TLS disconnect rejects the controller's pending request, but does not automatically cancel host-side work. The gateway can continue executing and journal a completed result. Reconnection alone does not prove it is safe to repeat side effects.

A cancel response only says whether an active operation was asked to abort. Wait for terminal evidence and inspect any side effects. For destructive work, use application-level idempotency and independent completion checks.

## Upgrade procedure

1. Record the currently installed release and controller assignment/trust state.
2. Drain work. Use a local terminal or SSH session independent of Node Goblin; the update stops its service and service-owned child processes.
3. Make protected backups of configuration and state. Preserve ownership and permissions.
4. Review and run the bootstrap with `sudo sh install.sh --update` (latest) or `sudo sh install.sh --update --version YYYY.MM.DD[.N]` using an actual published version. Alternatively extract the selected verified archive and run `sudo sh deploy/update.sh`. The update validates/stages the replacement, stops the service, installs it, reloads systemd, restarts, and checks active state as one operation. It preserves configuration, identity, trust, and operation journal. First-time `install.sh` behavior is unchanged.
5. If installation/restart fails, the updater restores the previous package/deployment assets and attempts to restart the old service; it exits nonzero. If stopping the candidate or restoring assets fails, recovery assets are retained at the path reported in the error. Do not treat a failed update as success. Restart BURROW only if separate mod/controller changes require it.
6. Verify authentication, target selection, a harmless process, and a filesystem read in the intended workspace.
7. Keep the prior program package until the new version is verified. A code rollback does not automatically roll back external process side effects or storage format changes.

The public bootstrap downloads from `GoblinKing-Burrow/Node-Goblin`. Development
packages from `NightShaman/Node-Goblin` are separate; use the README's explicit
repository override only when intentionally testing them. The immutable public
`2026.10.23` release predates `--update`; public updater availability requires a
later promoted release containing it.

Node Goblin releases have their own calendar versions and packages. Use the selected Node Goblin release and checksum when upgrading the host; a BURROW upgrade is not evidence that the host runtime changed.

## Telemetry and execution evidence

Core Settings can deliver OTLP/HTTP telemetry configuration to connected hosts. Host environment overrides take precedence; check [configuration](configuration.md#telemetry-overrides) if disabling or changing Core telemetry appears ineffective. Export is bounded and best-effort, so collector failures or dropped spans do not establish whether a host operation ran. Use operation results and journal evidence for recovery, not the presence or absence of a trace alone.

## Backup and restore

Back up host config/state and the controller's Core-owned settings/secrets with their required encryption keys. Host `node-identity.json` contains a private key; HMAC trust contains a secret; operation journals can contain command output or file contents. Encrypt and restrict backup access.

Restore to an isolated host first. Avoid starting two copies of the same identity. Preserve `burrow` ownership and intended modes. Check endpoint, TLS pins, pairing status, and workspace paths before resuming work.

Journal retention is bounded by time/count and is not an audit archive. The listener activity list is memory-only. Durable correlation does not contain all raw terminal output. If long-term audit retention is required, design it explicitly in the surrounding deployment with privacy controls.

## Remove or change trust

Follow the [pairing recovery procedure](pairing.md#recover-from-a-changed-controller-or-stuck-pairing) for changed controller trust. Revoke on the controller when the host should no longer be authorized. Unpair on the host when it should forget its controller. These are complementary actions. Verify active operating-system work separately, then re-pair only after comparing a new code.

Uninstall deliberately preserves configuration and state. Secure decommissioning requires a separate reviewed credential/data-retention decision; do not mistake package removal for erasure.

## Source references

- [`gateway/deploy/node-goblin`](https://github.com/GoblinKing-Burrow/Node-Goblin/blob/main/gateway/deploy/node-goblin)
- [`gateway/deploy/install.sh`](https://github.com/GoblinKing-Burrow/Node-Goblin/blob/main/gateway/deploy/install.sh)
- [`gateway/deploy/uninstall.sh`](https://github.com/GoblinKing-Burrow/Node-Goblin/blob/main/gateway/deploy/uninstall.sh)
- [`gateway/lib/network-transport.mjs`](https://github.com/GoblinKing-Burrow/Node-Goblin/blob/main/gateway/lib/network-transport.mjs)
- [`gateway/lib/journal.mjs`](https://github.com/GoblinKing-Burrow/Node-Goblin/blob/main/gateway/lib/journal.mjs)
