#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(dirname "$0")"

if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  source "$SCRIPT_DIR/.env"
  set +a
fi

if [ -z "${AMO_JWT_ISSUER:-}" ] || [ -z "${AMO_JWT_SECRET:-}" ]; then
  echo "Set AMO_JWT_ISSUER and AMO_JWT_SECRET in .env or as environment variables."
  echo "Get them from: https://addons.mozilla.org/developers/addon/api/key/"
  exit 1
fi

cd "$(dirname "$0")/extension"

npx web-ext sign \
  --api-key="$AMO_JWT_ISSUER" \
  --api-secret="$AMO_JWT_SECRET" \
  --channel=unlisted \
  --artifacts-dir ../web-ext-artifacts

echo ""
echo "Signed .xpi at:"
ls -la ../web-ext-artifacts/*.xpi 2>/dev/null || true
