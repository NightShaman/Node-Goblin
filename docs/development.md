# Development and documentation

*On narrow screens, swipe tables horizontally to see every column.*

Work in this repository for Node Goblin-specific behavior. Keep Core interfaces generic and use the registered `execution-provider-v1` contract instead of adding Node Goblin implementation details into BURROW Core.

## Source and runtime setup

The code uses native ECMAScript modules and Node built-ins. There is no runtime dependency installation step in `gateway/package.json`; CI tests with Node 24. The settings module is ESM through `ui/package.json`.

```bash
git clone https://github.com/GoblinKing-Burrow/Node-Goblin.git
cd Node-Goblin
node --version
(cd gateway && npm test)
node --test ui/settings.test.mjs
```

The gateway package test script runs gateway top-level tests, deployment/release tests under `gateway/test`, and `server/index.test.mjs`. It does **not** include `ui/settings.test.mjs`; run that explicitly.

Read tests before changing behavior. Test doubles cover socket/controller flows, while temporary roots keep deployment tests away from real accounts and services. Passing them does not prove a real network, systemd deployment, or BURROW-host integration works.

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

`.github/workflows/release-node-goblin.yml` is a fast NightShaman development gate. Main pushes run focused protocol, process, filesystem, network, protected-value, and version-identity contracts; they do not version, tag, or publish Node Goblin.

The scheduled NightShaman Burrow public-promotion workflow freezes this repository's exact main SHA, runs the complete Node Goblin suite, builds the deterministic archive/checksum, and publishes the coordinated UTC `YYYY.MM.DD` snapshot and release to `GoblinKing-Burrow/Node-Goblin`. Changes after that day's public release wait for the next UTC day.

For a local non-publishing build:

```bash
SOURCE_DATE_EPOCH=$(git show -s --format=%ct HEAD)   gateway/deploy/build-release.sh gateway/dist
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

The docs workflow builds/validates pull requests that touch docs configuration, pages, or checks and uploads the built site for review. Its Pages deployment job is restricted to main, after a successful build. Repository Pages configuration and merge/deployment approval remain separate operational steps. The workflow does not enable Pages settings itself.

When updating docs, link to the reviewed source revision, distinguish Core-owned APIs from mod APIs, and update [source coverage](source-map.md). Do not publish private audit evidence, secrets, or host details in the documentation tree.

## Source references

- [`gateway/package.json`](https://github.com/NightShaman/Node-Goblin/blob/12d0f1daf74516e1f0120c80ad4716bd09e1dead/gateway/package.json)
- [`.github/workflows/release-node-goblin.yml`](https://github.com/NightShaman/Node-Goblin/blob/12d0f1daf74516e1f0120c80ad4716bd09e1dead/.github/workflows/release-node-goblin.yml)
- [`gateway/deploy/build-release.sh`](https://github.com/NightShaman/Node-Goblin/blob/12d0f1daf74516e1f0120c80ad4716bd09e1dead/gateway/deploy/build-release.sh)
- [`gateway/deploy/set-release-version.mjs`](https://github.com/NightShaman/Node-Goblin/blob/12d0f1daf74516e1f0120c80ad4716bd09e1dead/gateway/deploy/set-release-version.mjs)

### Runtime cleanup contracts

Node Goblin supports Node 24.x. The read-only pull-request runtime workflow runs
all gateway, controller/server, deployment/package and UI settings contract tests;
publishing occurs only after the coordinated daily public validation. Runtime identity
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
do not migrate a paired identity. The Smatchet-owned settings UI must hide or
disable shared-secret replacement for `method: ed25519`, and label HMAC actions
as legacy-only; that renderer change is not part of this runtime cleanup.

Release archives use an explicit runtime/deployment allowlist. Default, external,
and custom in-tree output directories are supported; output under `lib` or
`deploy`, or the gateway source root itself, is rejected to prevent output from
becoming runtime input.
