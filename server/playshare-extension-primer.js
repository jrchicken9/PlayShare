/**
 * Extension architecture primer for diagnostic AI — combines auto-generated snapshot
 * (versions + file inventory) with a hand-maintained narrative (.static.md).
 *
 * Regenerate the auto section: `npm run generate:primer`
 * (runs after `bump:extension` and before `package:extension`).
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const autoPath = path.join(__dirname, 'playshare-extension-primer.auto.md');
const staticPath = path.join(__dirname, 'playshare-extension-primer.static.md');
const metaPath = path.join(__dirname, 'playshare-extension-primer.meta.json');

function readUtf8(p) {
  return fs.readFileSync(p, 'utf8');
}

let auto = '';
try {
  auto = readUtf8(autoPath).trim();
} catch {
  auto =
    '## Release & codebase snapshot\n\n_Run `npm run generate:primer` from the repo root to generate the auto section._\n';
}

let staticPart = '';
try {
  staticPart = readUtf8(staticPath).trim();
} catch (e) {
  throw new Error('playshare-extension-primer.static.md is required next to playshare-extension-primer.js');
}

const EXTENSION_PRIMER_MARKDOWN = auto ? `${auto}\n\n---\n\n${staticPart}` : staticPart;

let EXTENSION_PRIMER_VERSION = 'unknown';
try {
  const meta = JSON.parse(readUtf8(metaPath));
  const sha = meta.gitSha ? `+${meta.gitSha}` : '';
  EXTENSION_PRIMER_VERSION = `${meta.extensionVersion || '?'}@${meta.generatedAt || '?'}${sha}`;
} catch {
  try {
    const manifest = JSON.parse(readUtf8(path.join(root, 'manifest.json')));
    EXTENSION_PRIMER_VERSION = `${manifest.version || '0.0.0'}+primer-meta-missing`;
  } catch {
    EXTENSION_PRIMER_VERSION = '0.0.0+primer-meta-missing';
  }
}

module.exports = {
  EXTENSION_PRIMER_MARKDOWN,
  EXTENSION_PRIMER_VERSION
};
