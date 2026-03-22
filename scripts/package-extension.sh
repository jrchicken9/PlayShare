#!/usr/bin/env bash
# Build a Chrome Web Store–ready .zip (no node_modules, no server, no sources).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OUT="${1:-playshare-extension.zip}"
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
  shared/join-link-utils.js \
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
