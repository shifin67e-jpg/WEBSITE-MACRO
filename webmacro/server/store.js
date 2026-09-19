'use strict';
/**
 * Tiny JSON file store for the macro library.
 * Writes atomically and never throws upward — a read-only FS (no volume mounted)
 * must not take the server down.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const config = require('./config');
const { uid } = require('./util');

const FILE = path.join(config.dataDir, 'macros.json');

let cache = null;
let writeTimer = null;
let degraded = false;

function emptyDb() {
  return { version: 1, macros: [], updatedAt: new Date().toISOString() };
}

async function load() {
  if (cache) return cache;
  try {
    const raw = await fsp.readFile(FILE, 'utf8');
    const parsed = JSON.parse(raw);
    cache = Object.assign(emptyDb(), parsed, { macros: Array.isArray(parsed.macros) ? parsed.macros : [] });
  } catch (_) {
    cache = emptyDb();
    try {
      await fsp.mkdir(config.dataDir, { recursive: true });
    } catch (err) {
      degraded = true;
      console.warn('[store] persistence unavailable, running in memory-only mode:', err.message);
    }
  }
  return cache;
}

function scheduleFlush() {
  if (degraded) return;
  clearTimeout(writeTimer);
  writeTimer = setTimeout(flush, 250);
}

async function flush() {
  if (degraded || !cache) return;
  try {
    await fsp.mkdir(config.dataDir, { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    cache.updatedAt = new Date().toISOString();
    await fsp.writeFile(tmp, JSON.stringify(cache, null, 2));
    await fsp.rename(tmp, FILE);
  } catch (err) {
    degraded = true;
    console.warn('[store] write failed, degrading to memory-only:', err.message);
  }
}

function blankMacro(partial = {}) {
  return Object.assign(
    {
      id: uid('macro'),
      name: 'Untitled macro',
      url: 'https://example.com',
      viewport: config.defaultViewport,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      humanize: { ...config.humanizeDefaults },
      refresh: { enabled: false, intervalMs: 60000, hard: false, jitterMs: 2500 },
      targets: [],
      steps: [],
      rules: [],
      autofill: { data: {}, cookies: [], localStorage: {} },
    },
    partial
  );
}

async function listMacros() {
  const db = await load();
  return db.macros;
}

async function getMacro(id) {
  const db = await load();
  return db.macros.find((m) => m.id === id) || null;
}

async function saveMacro(macro) {
  const db = await load();
  const now = new Date().toISOString();
  const incoming = Object.assign(blankMacro(), macro || {});
  if (!incoming.id) incoming.id = uid('macro');
  incoming.updatedAt = now;
  const idx = db.macros.findIndex((m) => m.id === incoming.id);
  if (idx >= 0) {
    incoming.createdAt = db.macros[idx].createdAt || now;
    db.macros[idx] = incoming;
  } else {
    db.macros.unshift(incoming);
  }
  scheduleFlush();
  return incoming;
}

async function deleteMacro(id) {
  const db = await load();
  const before = db.macros.length;
  db.macros = db.macros.filter((m) => m.id !== id);
  scheduleFlush();
  return before !== db.macros.length;
}

async function replaceAll(macros) {
  const db = await load();
  db.macros = (Array.isArray(macros) ? macros : []).map((m) => Object.assign(blankMacro(), m));
  scheduleFlush();
  return db.macros;
}

module.exports = {
  load,
  flush,
  blankMacro,
  listMacros,
  getMacro,
  saveMacro,
  deleteMacro,
  replaceAll,
  filePath: FILE,
  isDegraded: () => degraded,
};
