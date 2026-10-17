# Lifecycle repair pass 4 (NG07–NG10)

Installation validates required runtime modules and deployment assets before any
package replacement, checks copy creation and extraction separately, and retains
the previous package and deployment files until post-switch installation and
systemd reload succeed. A failed rollback retains its recovery directory rather
than deleting the last recovery copy. Existing configuration and durable state
are never replaced. This is an error-path transaction, not a power-loss-safe
multi-filesystem transaction. Stop/drain work before an upgrade as before.

`node-goblin configure` only saves settings. `connect` starts/enables the daemon
without interrupting an already-active process and explicitly warns that it does
not apply changes to that process. After draining active work, intentionally use
`sudo node-goblin apply --restart`. Its success means systemd reports active,
not that the node is paired or its controller is reachable. Restart failure is
returned to the caller; no active-success message is printed.

Unpair and uninstall require successful stop and a confirmed inactive/failed
state (or a confirmed absent inactive unit). Unknown service state, stop failure,
and a still-active unit preserve installed files and trust. Staging mode skips
systemd unless an explicit SYSTEMCTL stub is supplied for tests.

Controller `running` and TLS `ready` now mean that the listener emitted
`listening`, not that its object was constructed. Asynchronous listener failure
clears readiness and exposes only `controller_listener_start_failed`; close also
clears readiness. Existing settings mutation routes already return
`restartRequired: true`; no UI contract or UI implementation change is needed.

Regression fixtures are nonprivileged: injected command failures, temporary
package roots, service-manager stubs, and EventEmitter listener events. They do
not establish real systemd/distro behavior, crash durability, or live TLS drain.

## Executed validation

On Node 24.20.0 in the `repair/lifecycle` worktree:

- `env -u BURROW_GATEWAY_CONTROLLER_URL -u BURROW_GATEWAY_ID -u BURROW_GATEWAY_STATE_DIR npm test`
  from `gateway`: **75 passed**, zero failures/cancellations.
- `node --test ui/settings.test.mjs`: **3 passed**; UI files unchanged.
- POSIX `sh -n` on every deployment shell file and the operator command, and
  `git diff --check`: passed.

An initial unsanitized full-suite attempt inherited the host's gateway network
configuration and stalled the existing stdio-client daemon test. Repeating with
those three deployment variables removed passed; production/client behavior was
not changed to mask the environment issue.
