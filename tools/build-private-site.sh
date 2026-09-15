#!/bin/sh
set -eu
website_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec node "$website_dir/tools/build-unified.mjs"
