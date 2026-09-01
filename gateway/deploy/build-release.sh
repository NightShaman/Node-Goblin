#!/bin/sh
# Build a deterministic, directly installable Node Goblin release tarball.
set -eu
SOURCE=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
VERSION=$(cat "$SOURCE/VERSION")
case "$VERSION" in [0-9][0-9][0-9][0-9].[0-1][0-9].[0-3][0-9]|[0-9][0-9][0-9][0-9].[0-1][0-9].[0-3][0-9].[0-9]*) ;; *) echo "VERSION must be YYYY.MM.DD[.N]" >&2; exit 1;; esac
OUT=${1:-"$SOURCE/dist"}
NAME="node-goblin-$VERSION"
EPOCH=${SOURCE_DATE_EPOCH:-0}
mkdir -p "$OUT"
stage=$(mktemp -d); trap 'rm -rf "$stage"' EXIT HUP INT TERM
mkdir -p "$stage/$NAME"
( cd "$SOURCE" && tar --exclude='./dist' --exclude='./test' -cf - . ) | ( cd "$stage/$NAME" && tar -xf - )
find "$stage/$NAME" -type d -exec chmod 0755 {} +
find "$stage/$NAME" -type f -exec chmod 0644 {} +
chmod 0755 "$stage/$NAME/cli.mjs" "$stage/$NAME/node-goblin.mjs" "$stage/$NAME/deploy/"*.sh "$stage/$NAME/deploy/node-goblin"
# GNU tar options produce byte-identical output for a given source and epoch.
tar --sort=name --mtime="@$EPOCH" --owner=0 --group=0 --numeric-owner -C "$stage" -czf "$OUT/$NAME.tar.gz" "$NAME"
( cd "$OUT" && sha256sum "$NAME.tar.gz" >"$NAME.tar.gz.sha256" )
echo "$OUT/$NAME.tar.gz"
