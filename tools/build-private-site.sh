#!/bin/sh
set -eu

website_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
workspace_dir=$(CDPATH= cd -- "$website_dir/.." && pwd)
vault_dir=${VAULT_PRIVATE_DIR:-"$workspace_dir/vault-private"}

if [ -f "$website_dir/members/.env" ]; then
  set -a
  . "$website_dir/members/.env"
  set +a
fi

output_dir=${PRIVATE_SITE_DIR:-${MEMBERS_SITE_PATH:-"$website_dir/.cache/private-site"}}
base_url=${MEMBERS_BASE_URL:-http://127.0.0.1:8100}
c2_url=${MEMBERS_C2_URL:-http://127.0.0.1:8000}
public_url=${MEMBERS_PUBLIC_SITE_URL:-https://hafezigroupjqi.github.io}

command -v quarto >/dev/null 2>&1 || {
  echo "quarto is required: https://quarto.org/docs/get-started/" >&2
  exit 1
}
test -f "$website_dir/package-lock.json"
test -d "$vault_dir/.git"

cd "$vault_dir"
npm ci
npm run validate

cd "$website_dir"
npm ci
npm run setup:browser
INTERNAL_C2_URL="$c2_url" PUBLIC_SITE_URL="$public_url" npm run build -- \
  --mode internal \
  --content "$vault_dir" \
  --output "$output_dir" \
  --base-url "$base_url"

echo "private site built at $output_dir"
