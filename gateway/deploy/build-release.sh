#!/bin/sh
# Build a deterministic, directly installable Node Goblin release tarball.
set -eu
SOURCE=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
. "$SOURCE/deploy/package-common.sh"
validate_package "$SOURCE"
VERSION=$(cat "$SOURCE/VERSION")
case "$VERSION" in [0-9][0-9][0-9][0-9].[0-1][0-9].[0-3][0-9]|[0-9][0-9][0-9][0-9].[0-1][0-9].[0-3][0-9].[0-9]*) ;; *) echo "VERSION must be YYYY.MM.DD[.N]" >&2; exit 1;; esac
OUT=${1:-"$SOURCE/dist"}
NAME="node-goblin-$VERSION"
EPOCH=${SOURCE_DATE_EPOCH:-0}
mkdir -p "$OUT"
OUT=$(CDPATH= cd -- "$OUT" && pwd -P)
case "$OUT" in "$SOURCE"|"$SOURCE/lib"|"$SOURCE/lib/"*|"$SOURCE/deploy"|"$SOURCE/deploy/"*) echo "Unsafe build output directory" >&2; exit 1;; esac
stage=$(mktemp -d); trap 'rm -rf "$stage"' EXIT HUP INT TERM
mkdir -p "$stage/$NAME"
# Package only runtime/deployment authorities, never arbitrary build outputs.
( cd "$SOURCE" && tar -cf "$stage/source.tar" cli.mjs node-goblin.mjs index.mjs lib deploy package.json VERSION )
( cd "$stage/$NAME" && tar -xf "$stage/source.tar" )
validate_package "$stage/$NAME"
find "$stage/$NAME" -type d -exec chmod 0755 {} +
find "$stage/$NAME" -type f -exec chmod 0644 {} +
chmod 0755 "$stage/$NAME/cli.mjs" "$stage/$NAME/node-goblin.mjs" "$stage/$NAME/deploy/"*.sh "$stage/$NAME/deploy/node-goblin"
# GNU tar options produce byte-identical output for a given source and epoch.
tar --sort=name --mtime="@$EPOCH" --owner=0 --group=0 --numeric-owner -C "$stage" -czf "$stage/$NAME.tar.gz" "$NAME"
( cd "$stage" && sha256sum "$NAME.tar.gz" >"$NAME.tar.gz.sha256" )
mv "$stage/$NAME.tar.gz" "$OUT/$NAME.tar.gz"
mv "$stage/$NAME.tar.gz.sha256" "$OUT/$NAME.tar.gz.sha256"
echo "$OUT/$NAME.tar.gz"
