#!/usr/bin/env bash
# Store-ready zip (no diagnostics UI) + developer zip (same manifest version, diagnostics on).
# Restores content/content.bundle.js to the release build when finished.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

npm run sync-streaming
npm run build:content
bash scripts/package-extension.sh playshare-extension.zip
npm run build:content:dev

MAN_BAK="$(mktemp)"
cp manifest.json "$MAN_BAK"
node scripts/apply-dev-extension-label.mjs
bash scripts/package-extension.sh playshare-extension-dev.zip
cp "$MAN_BAK" manifest.json
rm -f "$MAN_BAK"

npm run build:content

echo ""
echo "Store upload:     $(pwd)/playshare-extension.zip"
echo "Developer load:   $(pwd)/playshare-extension-dev.zip  (shows as \"PlayShare (Developer)\" in chrome://extensions; diagnostics on; same version as store zip)"
