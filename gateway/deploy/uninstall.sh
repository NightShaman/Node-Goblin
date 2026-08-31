#!/bin/sh
# Remove program and unit while preserving account, configuration, and state for safe reinstalls.
set -eu
ROOT=${BURROW_GATEWAY_ROOT:-/}
NO_SYSTEMD=false
usage() { echo "usage: $0 [--root DIRECTORY] [--no-systemd]" >&2; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --root) ROOT=$2; shift 2 ;;
    --no-systemd) NO_SYSTEMD=true; shift ;;
    *) usage; exit 2 ;;
  esac
done
path() { printf '%s%s\n' "${ROOT%/}" "$1"; }
if [ "$ROOT" = / ] && [ "$(id -u)" -ne 0 ]; then echo "uninstaller must run as root" >&2; exit 1; fi
if [ "$NO_SYSTEMD" = false ] && [ "$ROOT" = / ]; then
  systemctl disable --now burrow-host-gateway.service || true
fi
rm -f "$(path /etc/systemd/system/burrow-host-gateway.service)"
rm -rf "$(path /opt/burrow-host-gateway)"
if [ "$NO_SYSTEMD" = false ] && [ "$ROOT" = / ]; then systemctl daemon-reload; fi
echo "Removed program and unit. Preserved /etc/burrow-host-gateway, /var/lib/burrow-host-gateway, and burrow UID/GID 4226."
