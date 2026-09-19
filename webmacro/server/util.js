'use strict';

let counter = 0;

function uid(prefix = 'id') {
  counter = (counter + 1) % 100000;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms | 0)));

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function randInt(min, max) {
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function normalizeUrl(input, fallback = 'https://example.com') {
  let raw = String(input == null ? '' : input).trim();
  if (!raw) raw = fallback;
  // Accept "example.com", "localhost:3000", "https://x", "about:blank"
  if (/^(about:|data:|file:|chrome:)/i.test(raw)) return raw;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^[\w.-]+(:\d+)?(\/.*)?$/.test(raw)) return 'https://' + raw;
  return raw;
}

function safeJson(text, fallback = null) {
  if (text === null || text === undefined) return fallback;
  if (typeof text === 'object') return text;
  try {
    return JSON.parse(text);
  } catch (_) {
    return fallback;
  }
}

function truncate(s, n = 160) {
  const str = String(s == null ? '' : s);
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch (_) {
    return url;
  }
}

module.exports = { uid, sleep, clamp, randInt, normalizeUrl, safeJson, truncate, hostOf };
