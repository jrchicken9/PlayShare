/**
 * Full PlayShare dashboard (same UI as the Electron renderer) for https://host/dashboard
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const dashDir = path.join(root, 'public', 'dashboard');
const rendererDir = path.join(root, 'apps', 'desktop', 'renderer');

fs.mkdirSync(dashDir, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(rendererDir, 'entry.js')],
  bundle: true,
  outfile: path.join(dashDir, 'bundle.js'),
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  legalComments: 'none',
  charset: 'utf8'
});

fs.copyFileSync(path.join(rendererDir, 'styles.css'), path.join(dashDir, 'styles.css'));

let html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\s*/i, '');
html = html.replace(/\.\/styles\.css/g, '/dashboard/styles.css');
html = html.replace(/\.\/brand-mark\.svg/g, '/brand-mark.png');
html = html.replace(/\.\/bundle\.js/g, '/dashboard/bundle.js');
html = html.replace(/<title>[^<]*<\/title>/, '<title>PlayShare — Dashboard</title>');

fs.writeFileSync(path.join(dashDir, 'index.html'), html, 'utf8');
console.log('[build-dashboard-web] wrote public/dashboard/{index.html,bundle.js,styles.css}');
