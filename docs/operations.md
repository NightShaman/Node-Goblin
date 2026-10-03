# Operations and recovery

*On narrow screens, swipe tables horizontally to see every column.*

Operate Node Goblin as a host-execution service. Check service health, controller connection, trust, and actual operation evidence separately.

## First verification

1. Check `sudo node-goblin status` and `sudo journalctl -u burrow-host-gateway.service -n 100 --no-pager` on the host.
2. Confirm the controller's current listener configuration and that the chosen port is reachable under your network policy.
3. Complete current code comparison and approval.
4. Confirm approved/connected state in BURROW.
5. Assign a test agent to a disposable absolute workspace and run a harmless read-only operation.
6. Check returned host identity, working directory, exit status, and target/operation IDs. A generic active status alone is insufficient.

Protect logs before sharing them. Pairing logs contain pairing codes; process results and filesystem journals can contain private content.

## Troubleshooting

| Symptom | Check | Safe next step |
| --- | --- | --- |
| Service will not start | Node path, readable env/state/TLS files, service account, journal JSON | Read service logs; correct the identified configuration problem |
| Service active, no controller connection | Endpoint/DNS/port, outbound network, controller bind interface | Verify both ends; service-active is only local process state |
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
2. Stop or drain work and stop the host service before replacing program files.
3. Make protected backups of configuration and state. Preserve ownership and permissions.
4. Review and install the selected release. The installer preserves config/state but replaces the executable package.
5. Restart BURROW if mod/controller changes require it; start the gateway service.
6. Verify authentication, target selection, a harmless process, and a filesystem read in the intended workspace.
7. Keep the prior program package until the new version is verified. A code rollback does not automatically roll back external process side effects or storage format changes.

The existing release workflow publishes on every push to main, including documentation-only pushes. Review that release behavior before merging documentation changes. The documentation workflow itself does not modify runtime version files.

## Backup and restore

Back up host config/state and the controller's Core-owned settings/secrets with their required encryption keys. Host `node-identity.json` contains a private key; HMAC trust contains a secret; operation journals can contain command output or file contents. Encrypt and restrict backup access.

Restore to an isolated host first. Avoid starting two copies of the same identity. Preserve `burrow` ownership and intended modes. Check endpoint, TLS pins, pairing status, and workspace paths before resuming work.

Journal retention is bounded by time/count and is not an audit archive. The listener activity list is memory-only. Durable correlation does not contain all raw terminal output. If long-term audit retention is required, design it explicitly in the surrounding deployment with privacy controls.

## Remove or change trust

Revoke on the controller when the host should no longer be authorized. Unpair on the host when it should forget its controller. These are complementary actions. Verify active operating-system work separately, then re-pair only after comparing a new code.

Uninstall deliberately preserves configuration and state. Secure decommissioning requires a separate reviewed credential/data-retention decision; do not mistake package removal for erasure.

## Source references

- [`gateway/deploy/node-goblin`](https://github.com/NightShaman/Node-Goblin/blob/12d0f1daf74516e1f0120c80ad4716bd09e1dead/gateway/deploy/node-goblin)
- [`gateway/deploy/install.sh`](https://github.com/NightShaman/Node-Goblin/blob/12d0f1daf74516e1f0120c80ad4716bd09e1dead/gateway/deploy/install.sh)
- [`gateway/deploy/uninstall.sh`](https://github.com/NightShaman/Node-Goblin/blob/12d0f1daf74516e1f0120c80ad4716bd09e1dead/gateway/deploy/uninstall.sh)
- [`gateway/lib/network-transport.mjs`](https://github.com/NightShaman/Node-Goblin/blob/12d0f1daf74516e1f0120c80ad4716bd09e1dead/gateway/lib/network-transport.mjs)
- [`gateway/lib/journal.mjs`](https://github.com/NightShaman/Node-Goblin/blob/12d0f1daf74516e1f0120c80ad4716bd09e1dead/gateway/lib/journal.mjs)
