'use strict';
/**
 * Single shared headless Chromium instance for every session.
 * One browser + many isolated contexts = fast cold starts, low RAM.
 */
const { chromium } = require('playwright');

let browserPromise = null;
let lastError = null;

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage', // critical inside containers with small /dev/shm
  '--disable-gpu',
  '--mute-audio',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=Translate,site-per-process,IsolateOrigins',
  '--autoplay-policy=no-user-gesture-required',
];

async function getBrowser() {
  if (browserPromise) {
    try {
      const b = await browserPromise;
      if (b && b.isConnected()) return b;
    } catch (_) {
      /* fall through to relaunch */
    }
    browserPromise = null;
  }

  browserPromise = chromium
    .launch({ headless: true, args: LAUNCH_ARGS, chromiumSandbox: false })
    .then((b) => {
      lastError = null;
      b.on('disconnected', () => {
        browserPromise = null;
      });
      return b;
    })
    .catch((err) => {
      lastError = err;
      browserPromise = null;
      throw err;
    });

  return browserPromise;
}

async function closeBrowser() {
  if (!browserPromise) return;
  try {
    const b = await browserPromise;
    await b.close();
  } catch (_) {
    /* ignore */
  }
  browserPromise = null;
}

function browserStatus() {
  return {
    launched: !!browserPromise,
    error: lastError ? String(lastError.message || lastError) : null,
  };
}

module.exports = { getBrowser, closeBrowser, browserStatus, LAUNCH_ARGS };
