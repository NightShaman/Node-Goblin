# Shared package preflight. Source this file; do not execute it.
validate_package() {
  package=$1
  for asset in VERSION package.json cli.mjs node-goblin.mjs index.mjs \
    lib/client.mjs lib/controller-listener.mjs lib/daemon.mjs lib/filesystem-runner.mjs \
    lib/journal.mjs lib/network-transport.mjs lib/pairing.mjs lib/process-runner.mjs lib/protocol.mjs \
    deploy/install.sh deploy/uninstall.sh deploy/node-goblin deploy/burrow-host-gateway.service \
    deploy/gateway.env.example deploy/package-common.sh deploy/service-common.sh; do
    [ -s "$package/$asset" ] && [ ! -L "$package/$asset" ] || {
      echo "Incomplete package: $asset" >&2; return 1;
    }
  done
  for module in "$package/"*.mjs "$package/lib/"*.mjs; do
    node --check "$module" || return 1
  done
}
