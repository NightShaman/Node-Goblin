#!/bin/sh
# Bootstrap the calendar-versioned Mini Node Goblin release owned by this repository.
set -eu

REPOSITORY=${NODE_GOBLIN_REPOSITORY:-GoblinKing-Burrow/Node-Goblin}
VERSION=${NODE_GOBLIN_VERSION:-latest}
CONTROLLER=
NODE_ID=
TMP=

usage() {
  cat >&2 <<'EOF'
usage: install.sh [--version YYYY.MM.DD[.N]] [--controller HOST:PORT] [--node-id ID]

Installs the latest calendar-versioned Mini Node Goblin release by default.
Controller address and node ID are non-secret and may be supplied now or
configured later with: sudo node-goblin configure
EOF
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) VERSION=$2; shift 2 ;;
    --controller) CONTROLLER=$2; shift 2 ;;
    --node-id) NODE_ID=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done

valid_version() {
  printf '%s\n' "$1" | grep -Eq '^[0-9]{4}\.[0-9]{2}\.[0-9]{2}(\.[1-9][0-9]*)?$'
}
if [ "$VERSION" != latest ] && ! valid_version "$VERSION"; then
  echo "version must be YYYY.MM.DD, YYYY.MM.DD.N, or latest" >&2
  exit 2
fi
if [ -n "$CONTROLLER" ] || [ -n "$NODE_ID" ]; then
  [ -n "$CONTROLLER" ] && [ -n "$NODE_ID" ] || { echo "--controller and --node-id must be supplied together" >&2; exit 2; }
fi
[ "$(id -u)" -eq 0 ] || { echo "Mini Node Goblin bootstrap must run as root" >&2; exit 1; }
for command in curl tar sha256sum; do command -v "$command" >/dev/null 2>&1 || { echo "$command is required" >&2; exit 1; }; done

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
if [ "$VERSION" = latest ]; then
  release_url="https://api.github.com/repos/$REPOSITORY/releases/latest"
  VERSION=$(curl -fsSL -H 'Accept: application/vnd.github+json' "$release_url" \
    | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\([^"]*\)".*/\1/p' | head -n 1)
  [ -n "$VERSION" ] || { echo "could not resolve the latest Node Goblin release" >&2; exit 1; }
  valid_version "$VERSION" || { echo "latest release has an invalid calendar version" >&2; exit 1; }
fi

NAME="node-goblin-$VERSION"
BASE="https://github.com/$REPOSITORY/releases/download/v$VERSION"
curl -fsSL "$BASE/$NAME.tar.gz" -o "$TMP/$NAME.tar.gz"
curl -fsSL "$BASE/$NAME.tar.gz.sha256" -o "$TMP/$NAME.tar.gz.sha256"
( cd "$TMP" && sha256sum -c "$NAME.tar.gz.sha256" )
tar -xzf "$TMP/$NAME.tar.gz" -C "$TMP"
"$TMP/$NAME/deploy/install.sh" --source "$TMP/$NAME"

if [ -n "$CONTROLLER" ]; then
  /usr/local/bin/node-goblin configure "$CONTROLLER" "$NODE_ID"
  /usr/local/bin/node-goblin connect
else
  echo "Next: sudo node-goblin configure"
fi
