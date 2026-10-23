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
RESTART=false
SERVICE=burrow-host-gateway.service
SYSTEMCTL_OVERRIDE=${SYSTEMCTL:-}
SYSTEMCTL=${SYSTEMCTL:-systemctl}

usage() { echo "usage: $0 [--root DIRECTORY] [--source DIRECTORY] [--no-systemd] [--skip-account] [--restart]" >&2; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --root) ROOT=$2; shift 2 ;;
    --source) SOURCE=$2; shift 2 ;;
    --no-systemd) NO_SYSTEMD=true; shift ;;
    --skip-account) SKIP_ACCOUNT=true; shift ;;
    --restart) RESTART=true; shift ;;
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

SOURCE=$(CDPATH= cd -- "$SOURCE" && pwd)
# Validate before account changes or replacing any installed assets.
. "$SOURCE/deploy/package-common.sh"
for tool in node tar install cp mv mktemp find chmod ln rm; do command -v "$tool" >/dev/null || exit 1; done
if [ "$NO_SYSTEMD" = false ] && [ "$ROOT" = / ]; then
  command -v "${SYSTEMCTL:-systemctl}" >/dev/null || exit 1
fi
validate_package "$SOURCE"
. "$SOURCE/deploy/service-common.sh"
if [ "$RESTART" = true ]; then
  [ "$NO_SYSTEMD" = false ] && { [ "$ROOT" = / ] || [ -n "$SYSTEMCTL_OVERRIDE" ]; } || {
    echo "--restart requires service management (staging tests must supply SYSTEMCTL)" >&2; exit 2;
  }
  [ -s "$(root_path /opt/burrow-host-gateway/VERSION)" ] || { echo "Update requires an installed Mini Node Goblin package" >&2; exit 1; }
  config="$(root_path /etc/burrow-host-gateway/gateway.env)"
  grep -q '^BURROW_GATEWAY_CONTROLLER_URL=tls://.' "$config" && grep -q '^BURROW_GATEWAY_ID=.' "$config" || {
    echo "Update requires an existing controller and node ID; run configure first" >&2; exit 1;
  }
  echo "Updating Mini Node Goblin: restarting the service will disconnect the host and stop service-owned child processes."
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
# Keep a same-filesystem transaction directory until all post-switch steps succeed.
transaction=$(mktemp -d "${INSTALL_DIR}.transaction.XXXXXX")
tmp="$transaction/package"
BIN_DIR=$(root_path /usr/local/bin)
mkdir -p "$tmp" "$BIN_DIR"
switched=false
service_stopped=false
restart_attempted=false
rollback() {
  result=$?
  set +e
  restore_failed=false
  trap - EXIT HUP INT TERM
  if [ "$switched" = true ]; then
    if [ "$restart_attempted" = true ] && ! stop_and_verify; then
      echo "Cannot stop failed candidate; recovery assets retained at $transaction" >&2
      exit 1
    fi
    rm -rf "$INSTALL_DIR"
    [ ! -e "$transaction/previous" ] || mv "$transaction/previous" "$INSTALL_DIR" || restore_failed=true
    for entry in unit operator alias; do
      case "$entry" in
        unit) destination="$UNIT_DIR/burrow-host-gateway.service" ;;
        operator) destination="$BIN_DIR/node-goblin" ;;
        alias) destination="$BIN_DIR/burrow-host-gateway" ;;
      esac
      rm -f "$destination"
      [ ! -e "$transaction/$entry" ] && [ ! -L "$transaction/$entry" ] || cp -a "$transaction/$entry" "$destination" || restore_failed=true
    done
    if [ "$NO_SYSTEMD" = false ] && { [ "$ROOT" = / ] || [ -n "$SYSTEMCTL_OVERRIDE" ]; }; then "$SYSTEMCTL" daemon-reload || restore_failed=true; fi
    if [ "$restore_failed" = true ]; then
      echo "Rollback incomplete; recovery assets retained at $transaction" >&2
      exit 1
    fi
    echo "Installation failed; restored previous package and deployment assets." >&2
  fi
  if [ "$service_stopped" = true ]; then
    "$SYSTEMCTL" restart "$SERVICE" && "$SYSTEMCTL" is-active --quiet "$SERVICE" || {
      echo "Previous package restored but service recovery failed; inspect systemctl status $SERVICE" >&2
      result=1
    }
  fi
  rm -rf "$transaction"
  exit "$result"
}
trap rollback EXIT
trap 'exit 1' HUP INT TERM
# No pipeline: producer and consumer must both succeed.
( cd "$SOURCE" && tar --exclude='./test' --exclude='./dist' -cf "$transaction/source.tar" . )
( cd "$tmp" && tar -xf "$transaction/source.tar" )
validate_package "$tmp"
find "$tmp" -type d -exec chmod 0755 {} +
find "$tmp" -type f -exec chmod 0644 {} +
chmod 0755 "$tmp/cli.mjs" "$tmp/node-goblin.mjs" "$tmp/deploy/"*.sh "$tmp/deploy/node-goblin"
[ ! -e "$UNIT_DIR/burrow-host-gateway.service" ] || cp -a "$UNIT_DIR/burrow-host-gateway.service" "$transaction/unit"
[ ! -e "$BIN_DIR/node-goblin" ] || cp -a "$BIN_DIR/node-goblin" "$transaction/operator"
if [ -e "$BIN_DIR/burrow-host-gateway" ] || [ -L "$BIN_DIR/burrow-host-gateway" ]; then cp -a "$BIN_DIR/burrow-host-gateway" "$transaction/alias"; fi
if [ "$RESTART" = true ]; then
  # Recovery also runs if a failed stop leaves the old service inactive.
  service_stopped=true
  stop_and_verify
fi
[ ! -d "$INSTALL_DIR" ] || mv "$INSTALL_DIR" "$transaction/previous"
switched=true
mv "$tmp" "$INSTALL_DIR"
chmod 0755 "$INSTALL_DIR/deploy/uninstall.sh"
chmod 0644 "$INSTALL_DIR/deploy/service-common.sh"
install -m 0644 "$INSTALL_DIR/deploy/burrow-host-gateway.service" "$UNIT_DIR/burrow-host-gateway.service"
install -m 0755 "$INSTALL_DIR/deploy/node-goblin" "$BIN_DIR/node-goblin"
ln -sf node-goblin "$BIN_DIR/burrow-host-gateway"
if [ ! -e "$CONFIG_DIR/gateway.env" ]; then
  install -m 0640 "$INSTALL_DIR/deploy/gateway.env.example" "$CONFIG_DIR/gateway.env"
  [ "$SKIP_ACCOUNT" = false ] && chown root:"$NAME" "$CONFIG_DIR/gateway.env"
fi

if [ "$NO_SYSTEMD" = false ] && [ "$ROOT" = / ] && [ "$RESTART" = false ]; then
  "$SYSTEMCTL" daemon-reload
fi
if [ "$RESTART" = true ]; then
  "$SYSTEMCTL" daemon-reload
  restart_attempted=true
  "$SYSTEMCTL" restart "$SERVICE"
  "$SYSTEMCTL" is-active --quiet "$SERVICE" || { echo "Updated service did not become active" >&2; exit 1; }
fi
switched=false
service_stopped=false
trap - EXIT HUP INT TERM
rm -rf "$transaction"
if [ "$RESTART" = true ]; then
  echo "Mini Node Goblin $(cat "$INSTALL_DIR/VERSION") installed and service restarted. Verify controller connection and a real operation."
else
  echo "Node Goblin installed. Run: sudo node-goblin configure"
  echo "Then start and verify it with: sudo node-goblin connect"
  echo "For future upgrades use deploy/update.sh (installs and restarts together)."
fi
