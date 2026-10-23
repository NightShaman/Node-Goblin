#!/bin/sh
# Run locally on the execution host after draining work, not through this service.
set -eu
SOURCE=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec sh "$SOURCE/deploy/install.sh" --restart "$@"
