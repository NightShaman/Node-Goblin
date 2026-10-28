# Development and documentation

*On narrow screens, swipe tables horizontally to see every column.*

Work in this repository for Node Goblin-specific behavior. Keep Core interfaces generic and use the registered `execution-provider-v1` contract instead of adding Node Goblin implementation details into Burrow Core.

## Source and runtime setup

The code uses native ECMAScript modules and Node built-ins. There is no runtime dependency installation step in `gateway/package.json`; CI tests with Node 24. The settings module is ESM through `ui/package.json`.

```bash
git clone https://github.com/GoblinKing-Burrow/Node-Goblin.git
cd Node-Goblin
node --version
(cd gateway && npm test)
node --test ui/settings.test.mjs
```

The gateway package test script runs gateway top-level tests, deployment/release tests under `gateway/test`, server tests, and UI settings tests. The separate UI command is useful for a focused check.

Read tests before changing behavior. Test doubles cover socket/controller flows, while temporary roots keep deployment tests away from real accounts and services. Passing them does not prove a real network, systemd deployment, or Burrow-host integration works.

## Test areas

| Suite | Main subject |
| --- | --- |
| `gateway/daemon.test.mjs` | Envelope handling, operation correlation, replay/conflict, lifecycle |
| `gateway/process-runner.test.mjs` | Process forms, timeout/output behavior |
| `gateway/filesystem-runner.test.mjs` | Traversal defaults, bounds, completeness |
| `gateway/network-transport.test.mjs` | Outbound TLS/authentication/reconnect/trust |
| `gateway/controller-listener.test.mjs` | Admission, dispatch, pairing, connection state/activity |
| `gateway/pairing.test.mjs` | Ed25519 identity/transcript behavior |
| `gateway/protected-e2e.test.mjs` | Protected delivery and redaction with isolated transport |
| `gateway/test/deploy.test.mjs` | Staging installation/operator/uninstall behavior |
| `gateway/test/release.test.mjs` | Packaged archive and deterministic build behavior |
| `gateway/test/release-version.test.mjs` | Version synchronization |
| `server/index.test.mjs` | HTTP registration, persistence, provider integration, settings |
| `ui/settings.test.mjs` | Declarative settings and action requests |

## Release behavior

Node Goblin owns its host archives, checksum files, and bootstrap installer. Public releases use `YYYY.MM.DD` and are published in [Node Goblin releases](https://github.com/GoblinKing-Burrow/Node-Goblin/releases). Select a release deliberately; a checkout of `main` can include documentation changes after the tagged release.

For a local non-publishing build:

```bash
SOURCE_DATE_EPOCH=$(git show -s --format=%ct HEAD) sh gateway/deploy/build-release.sh gateway/dist
node gateway/deploy/set-release-version.mjs "$(cat gateway/VERSION)" --check
```

The archive builder excludes `dist` and `test` directories, normalizes permissions/ownership/timestamps, and writes a SHA-256 sidecar. Review packaged contents when changing source layout.

## Documentation setup

Documentation uses MkDocs Material and Mermaid. Build dependencies and browser-test dependencies are pinned separately.

```bash
python3 -m venv .venv-docs
. .venv-docs/bin/activate
python -m pip install -r requirements-docs.txt -r requirements-docs-test.txt
python -m playwright install chromium
python -m mkdocs build --strict
python scripts/docs/check_site.py site
python scripts/docs/check_mermaid.py site --artifacts docs-browser-artifacts
```

Linux CI installs browser system dependencies with `playwright install --with-deps chromium`. If Chromium is already installed in an approved environment, `DOCS_CHROMIUM_EXECUTABLE` can select that executable. Use `python -m mkdocs serve` for local preview.

Checks cover strict Markdown/nav/link validation, built HTML links/anchors/assets, and actual browser rendering of every Mermaid diagram. Screenshots and browser diagnostics are artifacts, not source files. Review both desktop and narrow-screen readability after layout changes.

## Documentation workflow

The docs workflow strictly builds changed documentation and checks local links, fragments, and assets. Only pushes to the public repository’s `main` branch (or a manual run there) upload and deploy the site. Pull requests only validate. Repository Pages settings must already be configured; this workflow does not enable Pages or change DNS.

When updating docs, link to the reviewed source revision, distinguish Core-owned APIs from mod APIs, and update [source coverage](source-map.md). Do not publish private audit evidence, secrets, or host details in the documentation tree.

## Source references

- [`gateway/package.json`](https://github.com/GoblinKing-Burrow/Node-Goblin/blob/main/gateway/package.json)
- [`gateway/deploy/build-release.sh`](https://github.com/GoblinKing-Burrow/Node-Goblin/blob/main/gateway/deploy/build-release.sh)
- [`gateway/deploy/set-release-version.mjs`](https://github.com/GoblinKing-Burrow/Node-Goblin/blob/main/gateway/deploy/set-release-version.mjs)

### Runtime cleanup contracts

Node Goblin supports Node 24.x. The read-only pull-request runtime workflow runs
all gateway, controller/server, deployment/package and UI settings contract tests;
public packages are published as dated releases. Runtime identity
reads `gateway/VERSION`; the release stamper checks that file, the package and mod
manifest together. Protocol version `1.0` is independent of the calendar release.

The controller retains the most recently updated 256 **terminal** correlation
records. Unresolved dispatches are never evicted by that limit. This is bounded
history, not an exactly-once guarantee; after eviction, gateway journal retention
still governs replay. The settings API supports aggregate storage here, so writes
are still serialized array updates rather than a claimed keyed-store migration.
The gateway journal only rewrites on mutations or actual expiry/limit cleanup.

The local development `GatewayClient` rejects outstanding requests on EOF, parse
failure, stream error and child exit. Requests may opt into `timeoutMs` or an
`AbortSignal`; neither imposes a default deadline nor cancels remote execution.
Call `close()` to end input and await the child, and retain caller-owned process
termination for a child that refuses to exit. The local spawn helper explicitly
selects stdio even when a controller URL exists in the caller's environment.

Protocol `shutdown` is idle-only: active work returns `shutdown_requires_idle`
without cancelling it or entering stopping state. After an idle shutdown begins,
new execution requests return `gateway_stopping`. Listener close is awaitable and
drains every accepted socket, including pre-authentication sockets. Authentication
and pending pairing have a 60-second lifetime per connection; operators can retry
pairing after a fresh connection if approval takes longer.

Legacy shared-secret changes for Ed25519 identities return HTTP 409
`gateway_credential_method_ed25519`, without modifying credentials. These actions
do not migrate a paired identity. Use the pairing workflow for Ed25519 identities. Shared-secret replacement is a legacy HMAC operation, not an identity migration.

Release archives use an explicit runtime/deployment allowlist. Default, external,
and custom in-tree output directories are supported; output under `lib` or
`deploy`, or the gateway source root itself, is rejected to prevent output from
becoming runtime input.

### Public-snapshot test compatibility

The updater correction makes bootstrap tests follow the release authority
stamped into each snapshot. Both the public authority and explicit development
override are exercised. The private development-workflow contract test is skipped
only when that workflow is intentionally absent from the public snapshot.

The following limitations describe older public snapshots, not the corrected
source:

The 2026.10.19 public snapshot retains development-release tests even though its promotion excludes the development release workflow. Its bootstrap fixtures also expect the development release authority rather than the public installer authority. Consequently, the aggregate `npm test` command can fail on those packaging/fixture assumptions. Do not treat this as a passing full suite or change the public installer to satisfy a development-only fixture. Focused runtime checks remain useful, but are not a substitute for fixing and rerunning the aggregate suite.

The reviewed public checkout also records deployment shell scripts without executable mode bits. Invoke the documented build script with `sh` as shown above; direct-execution deployment tests can fail before the script starts. This is a source-packaging issue, not evidence that a host installation was exercised.

### Multi-destination telemetry contracts

The gateway suite includes loopback JSON/protobuf fan-out, TLS/mTLS, partial-success accounting, and pre-upgrade operation-digest vectors. Core-integrated tests are opt-in and use an explicit source checkout:

```sh
BURROW_CORE_SOURCE_ROOT=/absolute/path/to/Burrow-Backend \
  npm --prefix gateway test
```

Core dependencies must be installed. The integration installs the actual mod in a disposable directory, forks Core's mod-host, pairs a loopback TLS gateway, and checks private destination ownership and trace identity at real receivers. It does not deploy or contact hosted collectors. Without the explicit checkout those cross-repository cases are skipped.
