# Shared package preflight. Source this file; do not execute it.
validate_package() {
  package=$1
  for asset in VERSION package.json cli.mjs node-goblin.mjs index.mjs \
    deploy/install.sh deploy/uninstall.sh deploy/node-goblin deploy/burrow-host-gateway.service \
    deploy/gateway.env.example deploy/package-common.sh deploy/service-common.sh; do
    [ -f "$package/$asset" ] && [ -s "$package/$asset" ] && [ ! -L "$package/$asset" ] || {
      echo "Incomplete package: $asset" >&2; return 1;
    }
  done
  # Runtime packages are copied and installed as authority. Reject links anywhere
  # in that tree rather than validating only a manually maintained leaf list.
  if [ -n "$(find "$package/lib" "$package/deploy" -type l -print -quit)" ]; then
    echo "Incomplete package: symbolic links are not allowed" >&2; return 1
  fi
  for module in "$package/"*.mjs "$package/lib/"*.mjs; do
    [ -f "$module" ] && [ ! -L "$module" ] || {
      echo "Incomplete package: $module" >&2; return 1;
    }
    node --check "$module" || return 1
  done
  # Syntax checks cannot detect a missing relative import. Import the public,
  # side-effect-free entry point so Node resolves the complete runtime graph.
  node --input-type=module -e 'import { pathToFileURL } from "node:url"; await import(pathToFileURL(process.argv[1]))' "$package/index.mjs" || {
    echo "Incomplete package: runtime dependency graph does not load" >&2; return 1
  }
  node --input-type=module -e '
    import fs from "node:fs";
    const root = process.argv[1];
    const metadata = JSON.parse(fs.readFileSync(`${root}/package.json`, "utf8"));
    const version = fs.readFileSync(`${root}/VERSION`, "utf8").trim();
    if (metadata.type !== "module" || metadata.version !== version || !/^\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$/.test(version)) process.exit(1);
  ' "$package" || {
    echo "Incomplete package: invalid or inconsistent package metadata" >&2; return 1
  }
}
