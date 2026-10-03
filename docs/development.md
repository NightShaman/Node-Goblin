# Development and documentation

Work in this repository for Node Goblin-specific behavior. Keep Core interfaces generic and use the registered `execution-provider-v1` contract instead of adding Node Goblin implementation details into BURROW Core.

## Source and runtime setup

The code uses native ECMAScript modules and Node built-ins. There is no runtime dependency installation step in `gateway/package.json`; CI tests with Node 24. The settings module is ESM through `ui/package.json`.

```bash
git clone https://github.com/NightShaman/Node-Goblin.git
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

`.github/workflows/release-node-goblin.yml` runs on main pushes and manual dispatch. It chooses a UTC calendar version, adding a numeric suffix while a matching tag exists; synchronizes manifest/package/VERSION; runs gateway tests; builds a deterministic GNU tar archive; commits version metadata to main; creates/pushes a tag; and publishes archive/checksum assets. An optional cross-repository token enables a BURROW source-updated dispatch.

The workflow checks out main rather than a feature branch. Do not manually dispatch it merely to validate a documentation PR. It publishes a release and changes repository state. Every main push currently qualifies, including docs-only changes.

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
