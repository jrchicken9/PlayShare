/**
 * Bundled as IIFE for classic extension pages (`popup`, `join`) that cannot import ESM.
 * Build: `npm run build:playshare-shared-bundles`
 */
import * as PlayShareExtensionMessages from './extension-messages.js';

globalThis.PlayShareExtensionMessages = PlayShareExtensionMessages;
