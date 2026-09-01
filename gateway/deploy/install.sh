#!/bin/sh
# Install the dependency-free Node Goblin package. Run as root on a systemd Linux host.
set -eu

UID_VALUE=4226
GID_VALUE=4226
NAME=burrow
ROOT=${BURROW_GATEWAY_ROOT:-/}
SOURCE=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
NO_SYSTEMD=false
SKIP_ACCOUNT=false

usage() { echo "usage: $0 [--root DIRECTORY] [--source DIRECTORY] [--no-systemd] [--skip-account]" >&2; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --root) ROOT=$2; shift 2 ;;
    --source) SOURCE=$2; shift 2 ;;
    --no-systemd) NO_SYSTEMD=true; shift ;;
    --skip-account) SKIP_ACCOUNT=true; shift ;;
    *) usage; exit 2 ;;
  esac
done

root_path() { printf '%s%s\n' "${ROOT%/}" "$1"; }
[ -d "$SOURCE" ] || { echo "Node Goblin source directory not found: $SOURCE" >&2; exit 1; }
if [ "$ROOT" = / ] && [ "$(id -u)" -ne 0 ]; then
  echo "installer must run as root (use --root with --skip-account for non-root package tests)" >&2
  exit 1
fi
if [ "$ROOT" != / ] && [ "$SKIP_ACCOUNT" = false ]; then
  echo "--root is a staging mode; it requires --skip-account" >&2
  exit 2
fi

if [ "$SKIP_ACCOUNT" = false ]; then
  # Adopt a conventional pre-existing burrow login (including a full account),
  # but use stable narrow IDs when this package creates the account itself.
  if getent passwd "$NAME" >/dev/null; then
    getent group "$NAME" >/dev/null || { echo "existing user $NAME requires a $NAME group" >&2; exit 1; }
    user_gid=$(getent passwd "$NAME" | awk -F: '{print $4}')
    group_gid=$(getent group "$NAME" | awk -F: '{print $3}')
    [ "$user_gid" = "$group_gid" ] || { echo "existing user $NAME must have $NAME as its primary group" >&2; exit 1; }
  else
    if getent group "$NAME" >/dev/null; then
      group_gid=$(getent group "$NAME" | awk -F: '{print $3}')
    elif getent group "$GID_VALUE" >/dev/null; then
      echo "GID $GID_VALUE is already assigned to another group" >&2; exit 1
    else
      groupadd --gid "$GID_VALUE" --system "$NAME"
      group_gid=$GID_VALUE
    fi
    if getent passwd "$UID_VALUE" >/dev/null; then
      echo "UID $UID_VALUE is already assigned to another user" >&2; exit 1
    fi
    useradd --uid "$UID_VALUE" --gid "$group_gid" --system --no-create-home --shell /usr/sbin/nologin "$NAME"
  fi
fi

INSTALL_DIR=$(root_path /opt/burrow-host-gateway)
CONFIG_DIR=$(root_path /etc/burrow-host-gateway)
STATE_DIR=$(root_path /var/lib/burrow-host-gateway)
UNIT_DIR=$(root_path /etc/systemd/system)
mkdir -p "$INSTALL_DIR" "$CONFIG_DIR" "$STATE_DIR" "$UNIT_DIR"
# A staging root intentionally does not chown to an account outside that root.
if [ "$SKIP_ACCOUNT" = false ]; then chown "$NAME:$NAME" "$STATE_DIR"; fi
chmod 0700 "$STATE_DIR"
# Replace executable package content but never configuration or durable trust/journal state.
tmp="$INSTALL_DIR.new.$$"
rm -rf "$tmp"; mkdir -p "$tmp"
( cd "$SOURCE" && tar --exclude='./deploy' --exclude='./test' -cf - . ) | ( cd "$tmp" && tar -xf - )
rm -rf "$INSTALL_DIR.old"; [ -d "$INSTALL_DIR" ] && mv "$INSTALL_DIR" "$INSTALL_DIR.old"
mv "$tmp" "$INSTALL_DIR"; rm -rf "$INSTALL_DIR.old"
install -m 0644 "$SOURCE/deploy/burrow-host-gateway.service" "$UNIT_DIR/burrow-host-gateway.service"
BIN_DIR=$(root_path /usr/local/bin)
mkdir -p "$BIN_DIR"
install -m 0755 "$SOURCE/deploy/node-goblin" "$BIN_DIR/node-goblin"
# Established automation may continue using the old command name.
ln -sf node-goblin "$BIN_DIR/burrow-host-gateway"
if [ ! -e "$CONFIG_DIR/gateway.env" ]; then
  install -m 0640 "$SOURCE/deploy/gateway.env.example" "$CONFIG_DIR/gateway.env"
  [ "$SKIP_ACCOUNT" = false ] && chown root:"$NAME" "$CONFIG_DIR/gateway.env"
fi

if [ "$NO_SYSTEMD" = false ] && [ "$ROOT" = / ]; then
  command -v systemctl >/dev/null || { echo "systemctl is required; use --no-systemd only for staging" >&2; exit 1; }
  systemctl daemon-reload
fi
echo "Node Goblin installed. Run: sudo node-goblin configure"
echo "Then start and verify it with: sudo node-goblin connect"
