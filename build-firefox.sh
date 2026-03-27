#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(dirname "$0")"

if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  source "$SCRIPT_DIR/.env"
  set +a
fi

cd "$SCRIPT_DIR/extension"

npx web-ext build \
  --overwrite-dest \
  --artifacts-dir ../web-ext-artifacts \
  --ignore-files '*.DS_Store'

echo ""
echo "Built addon at:"
ls -la ../web-ext-artifacts/*.zip 2>/dev/null || true
echo ""
echo "Rename .zip to .xpi for Firefox installation, or use sign-firefox.sh to sign it."
