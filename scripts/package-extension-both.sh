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
echo "Store / homepage: $(pwd)/playshare-extension.zip  (or run npm run package:extension → public/install/playshare-extension.zip)"
echo "Local dev only:   $(pwd)/playshare-extension-dev.zip  (not for distribution; diagnostics on; gitignored)"
