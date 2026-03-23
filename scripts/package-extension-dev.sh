#!/usr/bin/env bash
# Developer zip: diagnostics UI on, manifest shows "PlayShare (Developer)".
# Restores manifest.json after zipping; leaves content.bundle.js as the dev build.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

npm run sync-streaming
npm run build:content:dev

MAN_BAK="$(mktemp)"
cp manifest.json "$MAN_BAK"
node scripts/apply-dev-extension-label.mjs
bash scripts/package-extension.sh playshare-extension-dev.zip
cp "$MAN_BAK" manifest.json
rm -f "$MAN_BAK"

echo ""
echo "Developer build ready:"
echo "  Zip:  $(pwd)/playshare-extension-dev.zip"
echo "  Or:   chrome://extensions → Load unpacked → this folder (diagnostics on; name PlayShare in manifest)"
echo ""
