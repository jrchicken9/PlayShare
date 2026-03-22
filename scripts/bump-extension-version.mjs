#!/usr/bin/env node
/**
 * Bump PlayShare extension semver in manifest.json (patch | minor | major).
 * Popup UI reads version from the manifest at runtime — no other file needs editing.
 *
 * Usage:
 *   node scripts/bump-extension-version.mjs        # print current version
 *   node scripts/bump-extension-version.mjs patch  # 1.0.7 -> 1.0.8
 *   node scripts/bump-extension-version.mjs minor
 *   node scripts/bump-extension-version.mjs major
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const manifestPath = path.join(root, 'manifest.json');

const raw = fs.readFileSync(manifestPath, 'utf8');
const manifest = JSON.parse(raw);
const current = String(manifest.version || '0.0.0').trim();
const parts = current.split('.').map((n) => parseInt(n, 10) || 0);
while (parts.length < 3) parts.push(0);

const kind = (process.argv[2] || '').toLowerCase();
if (!kind || kind === 'current' || kind === 'print') {
  console.log(current);
  process.exit(0);
}

if (!['patch', 'minor', 'major'].includes(kind)) {
  console.error('Usage: node scripts/bump-extension-version.mjs [patch|minor|major]');
  process.exit(1);
}

if (kind === 'patch') {
  parts[2] += 1;
} else if (kind === 'minor') {
  parts[1] += 1;
  parts[2] = 0;
} else {
  parts[0] += 1;
  parts[1] = 0;
  parts[2] = 0;
}

const next = `${parts[0]}.${parts[1]}.${parts[2]}`;
const updated = raw.replace(/^(\s*"version"\s*:\s*")[^"]+(")/m, `$1${next}$2`);
if (updated === raw) {
  console.error('Could not find "version" line in manifest.json to replace.');
  process.exit(1);
}
fs.writeFileSync(manifestPath, updated, 'utf8');
console.log(`manifest.json version: ${current} → ${next}`);
console.log('Run: npm run build:content && npm run package:extension (before store upload).');
