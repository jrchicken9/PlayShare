#!/usr/bin/env node
/**
 * Builds apps/desktop/build/icon.icns from shared/brand-mark.png for electron-builder.
 * Requires macOS (iconutil). Run from any cwd: node scripts/build-desktop-mac-icon.mjs
 */
import sharp from 'sharp';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const brandPath = join(root, 'shared', 'brand-mark.png');
const buildDir = join(root, 'apps', 'desktop', 'build');
const iconsetDir = join(buildDir, 'icon.iconset');
const icnsOut = join(buildDir, 'icon.icns');

/** iconutil filename → edge size in pixels */
const ICONSET = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024]
];

if (process.platform !== 'darwin') {
  console.error('[build-desktop-mac-icon] iconutil is macOS-only. Build icon.icns on a Mac or copy from a teammate.');
  process.exit(1);
}

if (!existsSync(brandPath)) {
  console.error('[build-desktop-mac-icon] Missing', brandPath);
  process.exit(1);
}

rmSync(iconsetDir, { recursive: true, force: true });
mkdirSync(iconsetDir, { recursive: true });

for (const [name, size] of ICONSET) {
  await sharp(brandPath)
    .rotate()
    .ensureAlpha()
    .resize(size, size, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
      kernel: sharp.kernel.lanczos3
    })
    .png({ compressionLevel: 9 })
    .toFile(join(iconsetDir, name));
}

execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', icnsOut], { stdio: 'inherit' });
rmSync(iconsetDir, { recursive: true });

console.log('[build-desktop-mac-icon] wrote', icnsOut);
