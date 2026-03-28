/**
 * Human-placed recorder markers (diagnostics panel → IntelPro).
 * Codes are snake_case enums only — safe for synopsis / derived_tags after validation.
 */

/** @typedef {{ code: string, label: string, hint?: string }} RecorderMarkerPreset */

/** @type {RecorderMarkerPreset[]} */
export const DIAG_RECORDER_MARKER_PRESETS = [
  { code: 'detected_ad', label: 'Detected ad', hint: 'Extension/player cues match what you see' },
  { code: 'undetected_ad', label: 'Ad visible, missed detection', hint: 'You see an ad; extension likely did not' },
  { code: 'late_ad_detection', label: 'Late ad detection', hint: 'Ad state lagged vs on-screen ad' },
  { code: 'sync_desync_observed', label: 'Sync / drift issue', hint: 'Felt out of sync with room' },
  { code: 'buffering_or_stall_observed', label: 'Buffering / stall', hint: 'Long spinner or frozen buffer' },
  { code: 'playback_frozen_or_unresponsive', label: 'Playback frozen', hint: 'UI/time not advancing as expected' },
  { code: 'av_desync_observed', label: 'Audio / video mismatch', hint: 'Lip-sync or track drift' },
  { code: 'control_or_drm_issue', label: 'Controls / DRM error', hint: 'Scrubber, black screen, media error' }
];

const PRESET_CODES = new Set(DIAG_RECORDER_MARKER_PRESETS.map((p) => p.code));

/**
 * @param {unknown} raw
 * @returns {string|undefined} normalized code or undefined if invalid / unknown preset
 */
export function validateRecorderMarkerCode(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
    .slice(0, 48);
  if (!s || !/^[a-z][a-z0-9_]*$/.test(s)) return undefined;
  if (!PRESET_CODES.has(s)) return undefined;
  return s;
}
