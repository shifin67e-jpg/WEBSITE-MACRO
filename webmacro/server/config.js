'use strict';
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function int(v, d) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}
function bool(v, d) {
  if (v === undefined || v === null || v === '') return d;
  return /^(1|true|yes|on)$/i.test(String(v));
}

// Phone-first viewport presets. Streamed screenshots use deviceScaleFactor 1
// so 10 FPS stays cheap on mobile networks.
const VIEWPORTS = {
  'phone-xs': { width: 320, height: 568 },
  phone: { width: 390, height: 844 },
  'phone-lg': { width: 430, height: 932 },
  landscape: { width: 844, height: 390 },
  tablet: { width: 820, height: 1180 },
  laptop: { width: 1280, height: 720 },
  desktop: { width: 1440, height: 900 },
};

const config = {
  root: ROOT,
  port: int(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',

  // ---- streaming ----
  fps: Math.min(30, Math.max(1, int(process.env.STREAM_FPS, 10))),
  quality: Math.min(100, Math.max(10, int(process.env.STREAM_QUALITY, 55))),
  defaultViewport: VIEWPORTS[process.env.DEFAULT_VIEWPORT] ? process.env.DEFAULT_VIEWPORT : 'phone',
  viewports: VIEWPORTS,

  // ---- sessions ----
  maxSessions: int(process.env.MAX_SESSIONS, 4),
  sessionIdleMs: int(process.env.SESSION_IDLE_MS, 15 * 60 * 1000),
  navTimeoutMs: int(process.env.NAV_TIMEOUT_MS, 45000),

  // ---- persistence (best effort; falls back to ./data) ----
  dataDir: (process.env.DATA_DIR || '').trim() || path.join(ROOT, 'data'),

  // ---- engine ----
  pollMs: int(process.env.ENGINE_POLL_MS, 900),
  maxLogLines: int(process.env.MAX_LOG_LINES, 300),

  humanizeDefaults: {
    enabled: true,
    minDelay: 1500,
    maxDelay: 4000,
    typingMin: 60,
    typingMax: 190,
  },
};

module.exports = config;
module.exports.bool = bool;
module.exports.int = int;
