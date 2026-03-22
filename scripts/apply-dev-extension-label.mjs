#!/usr/bin/env node
/**
 * Sets manifest name + action.default_title for the developer-packaged zip.
 * Caller must restore manifest.json from backup afterward.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.join(__dirname, '..', 'manifest.json');
const DISPLAY_NAME = 'PlayShare (Developer)';

const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
m.name = DISPLAY_NAME;
if (m.action) m.action.default_title = DISPLAY_NAME;
fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2) + '\n');
