# A destructive action needs positive evidence of a stopped (or absent) unit.
stop_and_verify() {
  load=$("$SYSTEMCTL" show --property=LoadState --value "$SERVICE") || return 1
  if [ "$load" = not-found ]; then
    active=$("$SYSTEMCTL" show --property=ActiveState --value "$SERVICE") || return 1
    case "$active" in inactive|failed) return 0;; *) echo "Absent unit is not confirmed inactive" >&2; return 1;; esac
  fi
  [ "$load" = loaded ] || { echo "Cannot determine service state" >&2; return 1; }
  "$SYSTEMCTL" stop "$SERVICE" || { echo "Service stop failed; preserved installed files and trust" >&2; return 1; }
  active=$("$SYSTEMCTL" show --property=ActiveState --value "$SERVICE") || return 1
  case "$active" in inactive|failed) return 0;; *) echo "Service remains active; refusing destructive action" >&2; return 1;; esac
}
