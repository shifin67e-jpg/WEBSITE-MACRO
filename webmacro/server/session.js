'use strict';
/**
 * Browser sessions + the live-stream manager.
 *
 *   one socket  ->  one Session  ->  one Playwright BrowserContext + Page
 *
 * The page is streamed to every attached client as JPEG frames over Socket.io
 * (~10 FPS, volatile = drop frames instead of queueing them). Client canvas
 * coordinates are scaled back to real viewport coordinates before click/tap.
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { uid, normalizeUrl, sleep, clamp, truncate } = require('./util');
const { getBrowser } = require('./browser');
const Engine = require('./engine');

const AGENT_SRC = fs.readFileSync(path.join(__dirname, 'page-agent.js'), 'utf8');

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const TABLET_UA =
  'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

class Session {
  constructor(io, opts = {}) {
    this.io = io;
    this.id = opts.id || uid('sess');
    this.viewportName = config.viewports[opts.viewport] ? opts.viewport : config.defaultViewport;
    this.viewport = { ...config.viewports[this.viewportName] };
    this.fps = clamp(opts.fps || config.fps, 1, 30);
    this.quality = clamp(opts.quality || config.quality, 10, 100);

    this.clients = new Set();
    this.page = null;
    this.context = null;

    this.streaming = false;
    this._busy = false;
    this._timer = null;
    this.frameSeq = 0;
    this.frameBytes = 0;
    this.lastFrameAt = 0;
    this.fpsMeasured = 0;

    this.url = 'about:blank';
    this.title = '';
    this.ready = false;
    this.destroyed = false;
    this.createdAt = Date.now();
    this.lastActiveAt = Date.now();

    this.logs = [];
    this.engine = new Engine(this);
    this.recording = false;
    this.picking = false;
    this._scrollBuffer = { dx: 0, dy: 0, t: 0 };
    this._moveBuffer = null;
  }

  /* ---------------------------------------------------------------- */
  /* lifecycle                                                        */
  /* ---------------------------------------------------------------- */
  async init() {
    const browser = await getBrowser();
    const mobile = /^phone/.test(this.viewportName);
    this.context = await browser.newContext({
      viewport: this.viewport,
      deviceScaleFactor: 1,
      hasTouch: true,
      isMobile: mobile,
      userAgent: mobile ? MOBILE_UA : /^tablet/.test(this.viewportName) ? TABLET_UA : undefined,
      locale: 'en-US',
      ignoreHTTPSErrors: true,
    });
    await this.context.addInitScript({ content: AGENT_SRC });

    this.page = await this.context.newPage();
    this._wirePage(this.page);

    this.context.on('page', (p) => {
      // Popups / target=_blank: adopt the newest page as the live view.
      if (p !== this.page) {
        this.page = p;
        this._wirePage(p);
        setTimeout(() => this.syncState({ reason: 'popup' }), 400);
      }
    });

    this.ready = true;
    this.log('info', `Session ${this.id} ready · viewport ${this.viewport.width}×${this.viewport.height}`);
    this.emit('session:ready', this.describe());
    return this;
  }

  _wirePage(page) {
    page.setDefaultTimeout(config.navTimeoutMs).catch(() => {});
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        this.url = frame.url();
        this.syncState({ reason: 'navigate' });
      }
    });
    page.on('load', () => this.syncState({ reason: 'load' }));
    page.on('domcontentloaded', () => this.syncState({ reason: 'domcontentloaded' }));
    page.on('dialog', async (d) => {
      this.log('warn', `Dialog auto-accepted: ${d.type()} — "${truncate(d.message(), 90)}"`);
      try {
        await d.accept();
      } catch (_) {}
    });
    page.on('pageerror', (err) => this.log('error', `Page error: ${truncate(err.message, 140)}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') this.log('error', `Console: ${truncate(msg.text(), 140)}`);
    });
    page.on('crash', () => this.log('error', 'Page crashed — use Force Reload to re-initialize the buffer.'));
    page.on('close', () => this.log('warn', 'Page closed.'));
  }

  addClient(socket) {
    this.clients.add(socket.id);
    this.lastActiveAt = Date.now();
    socket.join(this.room());
    socket.emit('session:ready', this.describe());
    socket.emit('session:logs', this.logs.slice(-60));
    this.emit('session:clients', { count: this.clients.size });
    this.startStream();
  }

  removeClient(socketId) {
    this.clients.delete(socketId);
    this.emit('session:clients', { count: this.clients.size });
    if (this.clients.size === 0) this.stopStream();
  }

  get idle() {
    return this.clients.size === 0 && Date.now() - this.lastActiveAt > config.sessionIdleMs;
  }

  async destroy(reason = 'closed') {
    if (this.destroyed) return;
    this.destroyed = true;
    this.engine.stop('session destroyed');
    this.stopStream();
    try {
      if (this.context) await this.context.close();
    } catch (_) {}
    this.log('info', `Session disposed (${reason})`);
    this.emit('session:destroyed', { sessionId: this.id, reason });
  }

  room() {
    return `sess:${this.id}`;
  }

  emit(event, payload) {
    // volatile: a slow client drops frames rather than building a lag backlog
    this.io.to(this.room()).volatile.emit(event, payload);
  }

  describe() {
    return {
      sessionId: this.id,
      viewport: this.viewport,
      viewportName: this.viewportName,
      fps: this.fps,
      fpsMeasured: this.fpsMeasured,
      quality: this.quality,
      url: this.url,
      title: this.title,
      streaming: this.streaming,
      recording: this.recording,
      picking: this.picking,
      clients: this.clients.size,
      engine: this.engine.describe(),
      createdAt: this.createdAt,
    };
  }

  log(level, message) {
    const entry = { at: Date.now(), level, message };
    this.logs.push(entry);
    if (this.logs.length > config.maxLogLines) this.logs.shift();
    this.emit('session:log', entry);
  }

  async syncState(extra = {}) {
    try {
      if (this.page && !this.page.isClosed()) {
        this.url = this.page.url();
        this.title = await this.page.title().catch(() => this.title);
      }
    } catch (_) {}
    this.emit('session:state', { ...this.describe(), ...extra });
  }

  /* ---------------------------------------------------------------- */
  /* navigation                                                       */
  /* ---------------------------------------------------------------- */
  async goto(input, opts = {}) {
    this.lastActiveAt = Date.now();
    const url = normalizeUrl(input, this.url === 'about:blank' ? 'https://example.com' : this.url);
    this.log('info', `Navigating → ${url}`);
    try {
      await this.page.goto(url, {
        waitUntil: opts.hard ? 'load' : 'domcontentloaded',
        timeout: config.navTimeoutMs,
      });
      this.url = this.page.url();
      this.startStream();
      await this.syncState({ reason: 'goto', ordered: url });
      return { ok: true, url: this.url, title: this.title };
    } catch (err) {
      this.log('error', `Navigation failed: ${truncate(err.message, 160)}`);
      await this.syncState({ reason: 'goto-error' });
      return { ok: false, error: String(err.message || err), url };
    }
  }

  async forceReload() {
    this.log('info', 'Force reload — re-initializing the stream buffer.');
    this.stopStream();
    try {
      if (this.page && !this.page.isClosed()) {
        await this.page.reload({ waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs });
      } else if (this.context) {
        this.page = await this.context.newPage();
        this._wirePage(this.page);
        await this.page.goto(this.url || 'about:blank', { waitUntil: 'domcontentloaded' });
      }
    } catch (err) {
      this.log('warn', `Reload fallback: ${truncate(err.message, 140)}`);
      try {
        await this.page.goto(this.url, { waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs });
      } catch (e2) {
        this.log('error', `Reload failed: ${truncate(e2.message, 160)}`);
      }
    }
    this.startStream();
    await this.syncState({ reason: 'reload' });
    return { ok: true, url: this.page ? this.page.url() : this.url };
  }

  async setViewport(name) {
    if (!config.viewports[name]) return { ok: false, error: 'unknown viewport' };
    this.viewportName = name;
    this.viewport = { ...config.viewports[name] };
    if (this.page && !this.page.isClosed()) {
      await this.page.setViewportSize(this.viewport).catch(() => {});
    }
    this.log('info', `Viewport → ${name} (${this.viewport.width}×${this.viewport.height})`);
    this.emit('session:viewport', { viewport: this.viewport, viewportName: name });
    await this.syncState({ reason: 'viewport' });
    return { ok: true, viewport: this.viewport, viewportName: name };
  }

  async setStreamOpts({ fps, quality }) {
    if (fps) this.fps = clamp(fps, 1, 30);
    if (quality) this.quality = clamp(quality, 10, 100);
    if (this.streaming) {
      this.stopStream();
      this.startStream();
    }
    return { fps: this.fps, quality: this.quality };
  }

  /* ---------------------------------------------------------------- */
  /* streaming                                                        */
  /* ---------------------------------------------------------------- */
  startStream() {
    if (this.streaming || this.destroyed || !this.page) return;
    this.streaming = true;
    this._loop();
  }

  stopStream() {
    this.streaming = false;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    this.emit('session:stream', { streaming: false });
  }

  async _loop() {
    if (!this.streaming || this.destroyed) return;
    const interval = Math.round(1000 / this.fps);
    const started = Date.now();
    await this._capture();
    const elapsed = Date.now() - started;
    this.fpsMeasured = elapsed > 0 ? Math.round((1000 / Math.max(elapsed, 1)) * 10) / 10 : 0;
    this._timer = setTimeout(() => this._loop(), Math.max(0, interval - elapsed));
  }

  async _capture() {
    if (this._busy || !this.page || this.page.isClosed()) return;
    this._busy = true;
    try {
      const buf = await this.page.screenshot({ type: 'jpeg', quality: this.quality, timeout: 8000 });
      this.frameSeq++;
      this.frameBytes = buf.length;
      this.lastFrameAt = Date.now();
      if (this.clients.size) {
        this.io.to(this.room()).volatile.emit('frame', {
          seq: this.frameSeq,
          w: this.viewport.width,
          h: this.viewport.height,
          bytes: buf.length,
          at: this.lastFrameAt,
        }, buf);
      }
    } catch (err) {
      // A busy renderer or a navigation in flight simply skips a frame.
      if (!/closed|Target|Execution context/i.test(String(err.message))) {
        this.log('warn', `Frame skipped: ${truncate(err.message, 100)}`);
      }
    } finally {
      this._busy = false;
    }
  }

  async snapshot() {
    if (!this.page || this.page.isClosed()) return null;
    return this.page.screenshot({ type: 'png', fullPage: false });
  }

  /* ---------------------------------------------------------------- */
  /* input (client canvas coords -> real viewport coords)             */
  /* ---------------------------------------------------------------- */
  toPageCoords({ x, y, w, h }) {
    const cw = Number(w) || this.viewport.width;
    const ch = Number(h) || this.viewport.height;
    const sx = this.viewport.width / cw;
    const sy = this.viewport.height / ch;
    return {
      x: clamp(Math.round((Number(x) || 0) * sx), 0, this.viewport.width - 1),
      y: clamp(Math.round((Number(y) || 0) * sy), 0, this.viewport.height - 1),
    };
  }

  async input(kind, payload = {}) {
    this.lastActiveAt = Date.now();
    if (!this.page || this.page.isClosed()) return { ok: false, error: 'no page' };
    const p = this.toPageCoords(payload);
    try {
      switch (kind) {
        case 'click':
          await this.page.mouse.click(p.x, p.y, {
            button: payload.button || 'left',
            clickCount: payload.clickCount || 1,
            delay: 20,
          });
          break;
        case 'tap':
          await this.page.touchscreen.tap(p.x, p.y);
          break;
        case 'doubletap':
          await this.page.touchscreen.tap(p.x, p.y);
          await sleep(90);
          await this.page.touchscreen.tap(p.x, p.y);
          break;
        case 'move':
          await this.page.mouse.move(p.x, p.y);
          break;
        case 'scroll': {
          this._scrollBuffer.dx += Number(payload.dx) || 0;
          this._scrollBuffer.dy += Number(payload.dy) || 0;
          const now = Date.now();
          if (now - this._scrollBuffer.t > 60) {
            const { dx, dy } = this._scrollBuffer;
            this._scrollBuffer = { dx: 0, dy: 0, t: now };
            await this.page.evaluate(
              ([sx, sy]) => window.scrollBy(sx, sy),
              [dx, dy]
            );
          }
          break;
        }
        case 'wheel':
          await this.page.mouse.move(p.x, p.y);
          await this.page.mouse.wheel(Number(payload.dx) || 0, Number(payload.dy) || 0);
          break;
        case 'key':
          await this.page.keyboard.press(payload.key || 'Enter');
          break;
        case 'type':
          await this.page.keyboard.type(String(payload.text || ''), { delay: 45 });
          break;
        default:
          return { ok: false, error: `unknown input kind: ${kind}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  }

  /* ---------------------------------------------------------------- */
  /* picker / recorder                                                */
  /* ---------------------------------------------------------------- */
  async pickerStart(on = true) {
    this.picking = !!on;
    await this._agent('picker:start', on);
    this.emit('session:picker', { on: this.picking });
    await this.syncState({ reason: 'picker' });
    return { ok: true, on: this.picking };
  }

  async pickerPoll() {
    const res = await this._agent('picker:poll', null);
    return res || { done: false };
  }

  async recorderStart(on) {
    this.recording = !!on;
    await this._agent('recorder:start', on);
    this.emit('session:recorder', { on: this.recording });
    await this.syncState({ reason: 'recorder' });
    return { ok: true, on: this.recording };
  }

  async drainRecorder() {
    const res = await this._agent('recorder:drain', null);
    return res && Array.isArray(res.events) ? res.events : [];
  }

  async _agent(op, arg) {
    if (!this.page || this.page.isClosed()) return null;
    try {
      return await this.page.evaluate(
        ([operation, value]) => {
          const a = window.__MACRO_AGENT__;
          if (!a) return null;
          switch (operation) {
            case 'picker:start':
              a.picker.on = !!value;
              a.picker.done = false;
              if (!value) a.picker.result = null;
              if (typeof a.reset === 'function' && !value) a.reset();
              return { on: a.picker.on };
            case 'picker:poll':
              if (a.picker.result) {
                const r = a.picker.result;
                a.picker.result = null;
                return { done: true, element: r };
              }
              return { done: false };
            case 'recorder:start':
              a.recorder.on = !!value;
              if (value) a.recorder.events = [];
              return { on: a.recorder.on };
            case 'recorder:drain': {
              const events = a.recorder.events.slice();
              a.recorder.events = [];
              return { events };
            }
            case 'describe': {
              if (!a.helpers) return null;
              const el = document.querySelector(value);
              return el ? a.helpers.describe(el) : null;
            }
            default:
              return null;
          }
        },
        [op, arg === undefined ? null : arg]
      );
    } catch (_) {
      return null;
    }
  }
}

/* -------------------------------------------------------------------- */
/* Manager                                                              */
/* -------------------------------------------------------------------- */
class SessionManager {
  constructor(io) {
    this.io = io;
    this.sessions = new Map();
    this._reaper = setInterval(() => this.reap(), 60000);
    this._reaper.unref?.();
  }

  async create(opts = {}) {
    if (this.sessions.size >= config.maxSessions) {
      const victim = [...this.sessions.values()].find((s) => s.clients.size === 0);
      if (victim) await this.destroy(victim.id, 'capacity');
      else throw new Error(`Max sessions reached (${config.maxSessions}). Close a viewer tab first.`);
    }
    const session = new Session(this.io, opts);
    this.sessions.set(session.id, session);
    try {
      await session.init();
    } catch (err) {
      this.sessions.delete(session.id);
      throw new Error(`Browser launch failed: ${err.message}`);
    }
    return session;
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  async destroy(id, reason) {
    const s = this.sessions.get(id);
    if (!s) return false;
    await s.destroy(reason);
    this.sessions.delete(id);
    return true;
  }

  async reap() {
    for (const s of [...this.sessions.values()]) {
      if (s.idle) await this.destroy(s.id, 'idle-timeout');
    }
  }

  async destroyAll() {
    clearInterval(this._reaper);
    for (const id of [...this.sessions.keys()]) await this.destroy(id, 'shutdown');
  }

  list() {
    return [...this.sessions.values()].map((s) => s.describe());
  }
}

module.exports = { Session, SessionManager };
