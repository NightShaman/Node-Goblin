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
  if getent group "$NAME" >/dev/null; then
    [ "$(getent group "$NAME" | awk -F: '{print $3}')" = "$GID_VALUE" ] || { echo "group $NAME exists with a different GID" >&2; exit 1; }
  elif getent group "$GID_VALUE" >/dev/null; then
    echo "GID $GID_VALUE is already assigned to another group" >&2; exit 1
  else groupadd --gid "$GID_VALUE" --system "$NAME"; fi
  if getent passwd "$NAME" >/dev/null; then
    [ "$(getent passwd "$NAME" | awk -F: '{print $3":"$4}')" = "$UID_VALUE:$GID_VALUE" ] || { echo "user $NAME exists with a different UID/GID" >&2; exit 1; }
  elif getent passwd "$UID_VALUE" >/dev/null; then
    echo "UID $UID_VALUE is already assigned to another user" >&2; exit 1
  else useradd --uid "$UID_VALUE" --gid "$GID_VALUE" --system --no-create-home --shell /usr/sbin/nologin "$NAME"; fi
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
if [ ! -e "$CONFIG_DIR/gateway.env" ]; then
  install -m 0640 "$SOURCE/deploy/gateway.env.example" "$CONFIG_DIR/gateway.env"
  [ "$SKIP_ACCOUNT" = false ] && chown root:"$NAME" "$CONFIG_DIR/gateway.env"
fi

if [ "$NO_SYSTEMD" = false ] && [ "$ROOT" = / ]; then
  CONFIG_FILE="$CONFIG_DIR/gateway.env"
  controller_url=$(sed -n "s/^BURROW_GATEWAY_CONTROLLER_URL=//p" "$CONFIG_FILE" | tail -n 1)
  gateway_id=$(sed -n "s/^BURROW_GATEWAY_ID=//p" "$CONFIG_FILE" | tail -n 1)
  case "$controller_url" in ""|*controller.example*|*replace-with*) echo "configure BURROW_GATEWAY_CONTROLLER_URL before starting Node Goblin" >&2; exit 1;; esac
  case "$gateway_id" in ""|*replace-with*) echo "configure BURROW_GATEWAY_ID before starting Node Goblin" >&2; exit 1;; esac
  command -v systemctl >/dev/null || { echo "systemctl is required; use --no-systemd only for staging" >&2; exit 1; }
  systemctl daemon-reload
  systemctl enable --now burrow-host-gateway.service
fi
echo "Node Goblin installed; configure $CONFIG_DIR/gateway.env without placing secrets on command lines."
