# Audit repair pass 5

Scope: NG12 and NG14–NG19 from the 13 October 2026 audit. Release remains
2026.10.03 pending the separately owned final release stamp. No UI source changes.

- NG12: retain 256 latest terminal controller correlations; unresolved work is
  excluded from pruning. Aggregate settings writes remain serialized. Journal
  inspection no longer rewrites unchanged state; each put persists once.
- NG14: local client terminal events reject outstanding promises; optional finite
  timeouts/abort signals, tracked child exit and repeatable close are covered.
- NG15: all accepted sockets are owned separately from gateway identity; close
  returns an awaitable drain and authentication/pending admission has a deadline.
- NG16: enforce documented idle-only administrative shutdown, leaving active work
  intact on rejection and refusing new execution after stopping starts.
- NG17: key-paired identities reject legacy secret replacement with HTTP 409.
  Smatchet still owns hiding/disabling those controls and labeling HMAC-only forms.
- NG18: runtime hello and outbound auth read VERSION rather than a stale literal;
  tests compare manifest/package/VERSION/runtime while preserving protocol 1.0.
- NG19: package a runtime/deployment allowlist using checked producer and consumer
  steps. Repeated default/external/custom in-tree builds have identical bytes.

A read-only PR workflow and the release test entrypoint cover gateway, server and
UI contracts on the declared supported Node 24.x line. No release or push occurs
as part of this repair.

Local verification uses inert streams/sockets, scratch package installation and
benign child processes; it is not a full security review, real service-manager
exercise or deployment acceptance. Tests must unset inherited
BURROW_GATEWAY_STATE_DIR/ID/CONTROLLER_URL to avoid the runtime's real state.
No realistic host settings-RPC/disk-latency benchmark was performed; retention
and write-count regressions establish bounds, not a production latency claim.
