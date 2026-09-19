'use strict';
/**
 * Smoke test — proves the streaming primitive works end to end without HTTP:
 *   launch Chromium -> render a page -> capture a JPEG frame -> verify bytes.
 * Run: npm run smoke
 */
const { chromium } = require('playwright');
const { LAUNCH_ARGS } = require('../server/browser');

(async () => {
  const t0 = Date.now();
  const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS, chromiumSandbox: false });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  await page.setContent(
    '<html><body style="background:#000;color:#fff;font:600 20px system-ui;padding:24px">' +
      '<h1>stream ok</h1><button id="b">Tap me</button></body></html>'
  );
  const buf = await page.screenshot({ type: 'jpeg', quality: 55 });
  await page.touchscreen.tap(40, 120);
  console.log(`frame bytes=${buf.length} ok=${buf.length > 1000} ms=${Date.now() - t0}`);
  await browser.close();
  if (buf.length < 1000) {
    console.error('SMOKE FAILED: frame too small');
    process.exit(1);
  }
  console.log('SMOKE OK');
})().catch((err) => {
  console.error('SMOKE FAILED:', err);
  process.exit(1);
});
