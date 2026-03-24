#!/usr/bin/env bash
# Build a Chrome Web Store–ready .zip (no node_modules, no server, no sources).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

mkdir -p public/install
# Default: zip for homepage + Railway (GET /install/playshare-extension.zip). Pass a path for other artifacts (e.g. root zip for CI).
OUT="${1:-public/install/playshare-extension.zip}"
rm -f "$OUT"

zip -r "$OUT" \
  manifest.json \
  background.js \
  server-config.js \
  content/content.bundle.js \
  popup \
  sidebar \
  join \
  shared/streaming-hosts.generated.js \
  shared/diag-anonymize.js \
  shared/signal-permissions.js \
  shared/brand-mark.png \
  icons/icon16.png \
  icons/icon32.png \
  icons/icon48.png \
  icons/icon128.png \
  lib/supabase.min.js \
  -x "*.DS_Store"

echo "Wrote $(pwd)/$OUT ($(wc -c < "$OUT" | tr -d ' ') bytes)"
echo "Load in Chrome: chrome://extensions → Developer mode → Load unpacked (unzip first) or upload this zip to the Web Store."

# Homepage shows this next to the .zip download; matches manifest baked into the zip.
VERSION="$(node -p "JSON.parse(require('fs').readFileSync('manifest.json','utf8')).version")"
printf '%s\n' "$VERSION" > public/install/playshare-extension.version
echo "Wrote public/install/playshare-extension.version ($VERSION)"
