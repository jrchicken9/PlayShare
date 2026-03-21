/**
 * Build shared/brand-mark.png + icons/icon{16,32,48,128}.png from the master raster.
 *
 * - Edge flood-fill removes neutral black matte only; preserves red “back glow”, teal
 *   accent, and chrome/red borders (anything with real saturation or red/cyan cast).
 * - Icons use fit: 'contain' on a transparent square so nothing is cropped — correct
 *   for Chrome (toolbar + chrome://extensions).
 *
 * Env:
 *   KNOCKOUT_MAX_RGB_DISTANCE (default 48)
 *   KNOCKOUT_MIN_ALPHA (default 12)
 *   ICON_CONTENT_ZOOM (default 1) — if >1, center-crop before icons (can clip glow)
 *   MASTER_EXPORT_PX (default 4096) — square export for shared/brand-mark.png (try 8192
 *     for maximum supersampling; won’t invent detail but downscale→icons looks “retina”).
 *   ENHANCE_MASTER=0 — skip upscale / sharpen / color polish
 *   UI_BRAND_MAX_PX (default 512) — shared/brand-mark.png for popup/sidebar (fast load);
 *     icons are still built from the full polished resolution in memory.
 *
 * Run: npm run icons
 */
import sharp from 'sharp';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const masterPath = join(root, 'shared', 'brand-mark.png');
const outDir = join(root, 'icons');

if (!existsSync(masterPath)) {
  console.error('Missing', masterPath);
  process.exit(1);
}

const masterBuf = readFileSync(masterPath);
const maxRgbDist = Number(process.env.KNOCKOUT_MAX_RGB_DISTANCE || 48);
const toleranceSq = maxRgbDist * maxRgbDist;
const minAlpha = Number(process.env.KNOCKOUT_MIN_ALPHA || 12);
const iconContentZoom = Math.max(1, Number(process.env.ICON_CONTENT_ZOOM || 1));
const enhanceMaster = process.env.ENHANCE_MASTER !== '0';
const masterExportPx = Math.min(
  8192,
  Math.max(1024, Math.round(Number(process.env.MASTER_EXPORT_PX || 4096))),
);
const uiBrandMaxPx = Math.min(2048, Math.max(256, Math.round(Number(process.env.UI_BRAND_MAX_PX || 512))));

/**
 * Upscale + mild sharpen + subtle contrast polish so downsampling to 16–128px stays crisp
 * (supersampling). Does not add real detail beyond what the source contains.
 */
async function polishHighResMaster(pngBuffer) {
  if (!enhanceMaster) return pngBuffer;

  const meta = await sharp(pngBuffer).metadata();
  const w = meta.width || 1024;
  const h = meta.height || 1024;
  const side = Math.max(w, h);
  const target = masterExportPx;

  let pipeline = sharp(pngBuffer).ensureAlpha();
  const resized = side !== target;

  if (side < target) {
    pipeline = pipeline.resize(target, target, {
      kernel: sharp.kernel.lanczos3,
    });
  } else if (side > target) {
    pipeline = pipeline.resize(target, target, {
      kernel: sharp.kernel.lanczos3,
    });
  }

  // Sharpen / pop color only when we actually resampled (avoids stacking halos on repeat `npm run icons`)
  if (resized) {
    pipeline = pipeline
      .sharpen({
        sigma: 0.85,
        m1: 1.12,
        m2: 0.62,
      })
      .modulate({
        saturation: 1.06,
        brightness: 1.018,
      });
  }

  return pipeline
    .png({
      compressionLevel: 9,
      effort: 10,
      adaptiveFiltering: true,
    })
    .toBuffer();
}

/** Pixels that are clearly not flat black matte — keep (glow, neon rim, teal, chrome is already far from black). */
function shouldPreserveForegroundColor(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min > 42) return true;
  // Red floor glow / lit border spill
  if (r > 20 && r > g + 4 && r > b + 4) return true;
  // Teal / cyan accent
  if (g > 26 && b > 26 && g + b > r + r + 14) return true;
  return false;
}

function knockoutEdgeMatte(rgba, width, height, channels, minA) {
  if (channels !== 4) return rgba;
  const w = width;
  const h = height;
  const data = new Uint8ClampedArray(rgba);
  const stride = 4;

  const idx = (x, y) => (y * w + x) * stride;
  const cornerXY = [
    [0, 0],
    [w - 1, 0],
    [0, h - 1],
    [w - 1, h - 1],
  ];
  let br = 0;
  let bg = 0;
  let bb = 0;
  let n = 0;
  for (const [cx, cy] of cornerXY) {
    const p = idx(cx, cy);
    if (data[p + 3] < 128) continue;
    br += data[p];
    bg += data[p + 1];
    bb += data[p + 2];
    n++;
  }
  if (n === 0) {
    br = 0;
    bg = 0;
    bb = 0;
  } else {
    br /= n;
    bg /= n;
    bb /= n;
  }

  const distSqAt = (p) => {
    const r = data[p] - br;
    const g = data[p + 1] - bg;
    const b = data[p + 2] - bb;
    return r * r + g * g + b * b;
  };

  const seen = new Uint8Array(w * h);
  const stack = [];

  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const id = y * w + x;
    if (seen[id]) return;
    const p = id * stride;
    if (data[p + 3] < minA) return;
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    if (shouldPreserveForegroundColor(r, g, b)) return;
    if (distSqAt(p) > toleranceSq) return;
    seen[id] = 1;
    data[p + 3] = 0;
    stack.push(id);
  };

  for (let x = 0; x < w; x++) {
    push(x, 0);
    push(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    push(0, y);
    push(w - 1, y);
  }

  while (stack.length) {
    const id = stack.pop();
    const x = id % w;
    const y = (id / w) | 0;
    push(x + 1, y);
    push(x - 1, y);
    push(x, y + 1);
    push(x, y - 1);
  }

  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

const { data, info } = await sharp(masterBuf).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
if (info.channels !== 4) {
  console.error('Expected RGBA');
  process.exit(1);
}

const knocked = knockoutEdgeMatte(data, info.width, info.height, info.channels, minAlpha);

let normalized = await sharp(knocked, {
  raw: { width: info.width, height: info.height, channels: 4 },
})
  .png({ compressionLevel: 9 })
  .toBuffer();

if (iconContentZoom > 1) {
  const meta = await sharp(normalized).metadata();
  const iw = meta.width;
  const ih = meta.height;
  const z = iconContentZoom;
  const cropW = Math.max(1, Math.round(iw / z));
  const cropH = Math.max(1, Math.round(ih / z));
  const left = Math.max(0, Math.floor((iw - cropW) / 2));
  const top = Math.max(0, Math.floor((ih - cropH) / 2));
  normalized = await sharp(normalized)
    .extract({ left, top, width: cropW, height: cropH })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

normalized = await polishHighResMaster(normalized);

const hiresForIcons = normalized;
const displayForUi = await sharp(hiresForIcons)
  .resize(uiBrandMaxPx, uiBrandMaxPx, {
    fit: 'contain',
    position: 'centre',
    background: { r: 0, g: 0, b: 0, alpha: 0 },
    kernel: sharp.kernel.lanczos3,
  })
  .png({ compressionLevel: 9, effort: 10 })
  .toBuffer();

writeFileSync(masterPath, displayForUi);
const hiMeta = await sharp(hiresForIcons).metadata();
const uiMeta = await sharp(displayForUi).metadata();
console.log(
  `shared/brand-mark.png (${uiMeta.width}×${uiMeta.height} UI, from ${hiMeta.width}×${hiMeta.height} render${enhanceMaster ? '' : ' unpolished'})`,
);

mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  await sharp(hiresForIcons)
    .resize(size, size, {
      fit: 'contain',
      position: 'centre',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
      kernel: sharp.kernel.lanczos3,
    })
    .png({ compressionLevel: 9, effort: 10 })
    .toFile(join(outDir, `icon${size}.png`));
  console.log(`icons/icon${size}.png`);
}

console.log('Done.');
