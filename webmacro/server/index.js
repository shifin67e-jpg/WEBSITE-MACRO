'use strict';
/**
 * Web Automation Macro Platform — HTTP + Socket.io host.
 */
const http = require('http');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');

const config = require('./config');
const { SessionManager } = require('./session');
const { STEP_TYPES, CONDITION_TYPES } = require('./engine');
const store = require('./store');
const { browserStatus, closeBrowser } = require('./browser');
const { truncate } = require('./util');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  maxHttpBufferSize: 2 * 1024 * 1024,
  pingInterval: 20000,
  pingTimeout: 25000,
  cors: { origin: true, credentials: true },
  transports: ['websocket', 'polling'], // websocket first, polling fallback for locked-down networks
});

const manager = new SessionManager(io);
const bootAt = Date.now();

/* ------------------------------------------------------------------ */
/* middleware                                                          */
/* ------------------------------------------------------------------ */
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});
app.use(express.static(path.join(config.root, 'public'), { extensions: ['html'], maxAge: '1h' }));

/* ------------------------------------------------------------------ */
/* REST                                                                */
/* ------------------------------------------------------------------ */
app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    status: 'healthy',
    uptimeSec: Math.round((Date.now() - bootAt) / 1000),
    browser: browserStatus(),
    sessions: manager.list().length,
    maxSessions: config.maxSessions,
    fps: config.fps,
    storage: { dir: config.dataDir, degraded: store.isDegraded() },
    now: new Date().toISOString(),
  });
});

app.get('/api/meta', (req, res) => {
  res.json({
    stepTypes: STEP_TYPES,
    conditionTypes: CONDITION_TYPES,
    viewports: Object.entries(config.viewports).map(([name, size]) => ({ name, ...size })),
    defaults: { viewport: config.defaultViewport, fps: config.fps, quality: config.quality },
    limits: { maxSessions: config.maxSessions, zoom: { min: 0.5, max: 3 }, fps: { min: 1, max: 30 } },
  });
});

app.get('/api/macros', async (req, res) => {
  res.json({ ok: true, macros: await store.listMacros(), degraded: store.isDegraded() });
});

app.post('/api/macros', async (req, res) => {
  const saved = await store.saveMacro(req.body || {});
  res.json({ ok: true, macro: saved });
});

app.delete('/api/macros/:id', async (req, res) => {
  res.json({ ok: await store.deleteMacro(req.params.id) });
});

app.post('/api/macros/import', async (req, res) => {
  const macros = await store.replaceAll((req.body && req.body.macros) || []);
  res.json({ ok: true, count: macros.length });
});

// SPA fallback for anything that is not an API route
app.get(/^\/(?!api|socket\.io|healthz).*/, (req, res) => {
  res.sendFile(path.join(config.root, 'public', 'index.html'));
});

/* ------------------------------------------------------------------ */
/* auto-refresher (per session runtime utility)                        */
/* ------------------------------------------------------------------ */
function setAutoRefresh(session, opts = {}) {
  if (session._autoTimer) {
    clearTimeout(session._autoTimer);
    session._autoTimer = null;
  }
  session._autoCfg = {
    enabled: !!opts.enabled,
    intervalMs: Math.max(5000, Number(opts.intervalMs) || 60000),
    hard: !!opts.hard,
    jitterMs: Math.max(0, Number(opts.jitterMs) || 2500),
  };
  if (!session._autoCfg.enabled) {
    io.to(session.room()).emit('refresh:state', { ...session._autoCfg, ticks: session._autoTicks || 0 });
    return session._autoCfg;
  }
  session._autoTicks = 0;
  const loop = async () => {
    if (!session._autoCfg.enabled || session.destroyed) return;
    session._autoTicks = (session._autoTicks || 0) + 1;
    session.log('info', `Auto-refresh tick #${session._autoTicks}`);
    try {
      if (session.page && !session.page.isClosed()) {
        if (session._autoCfg.hard) await session.forceReload();
        else {
          await session.page.reload({ waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs });
          await session.syncState({ reason: 'auto-refresh' });
        }
      }
    } catch (err) {
      session.log('warn', `Auto-refresh failed: ${truncate(err.message, 120)}`);
    }
    io.to(session.room()).emit('refresh:state', { ...session._autoCfg, ticks: session._autoTicks });
    if (!session._autoCfg.enabled) return;
    const jitter = session._autoCfg.jitterMs ? Math.random() * session._autoCfg.jitterMs : 0;
    session._autoTimer = setTimeout(loop, session._autoCfg.intervalMs + jitter);
  };
  session._autoTimer = setTimeout(loop, session._autoCfg.intervalMs);
  session._autoTimer.unref?.();
  io.to(session.room()).emit('refresh:state', { ...session._autoCfg, ticks: 0 });
  return session._autoCfg;
}

/* ------------------------------------------------------------------ */
/* sockets                                                             */
/* ------------------------------------------------------------------ */
io.on('connection', (socket) => {
  let session = null;
  let pickTimer = null;

  const reply = (event, payload) => socket.emit(event, payload);
  const fail = (err) => socket.emit('error:msg', { message: String((err && err.message) || err) });

  const withSession = (fn) => async (payload) => {
    try {
      if (!session) {
        session = await manager.create({});
        socket.data.sessionId = session.id;
        session.addClient(socket);
      }
      await fn(session, payload || {});
    } catch (err) {
      fail(err);
    }
  };

  socket.on('session:create', async (payload = {}) => {
    try {
      if (session) {
        session.removeClient(socket.id);
        await manager.destroy(session.id, 'replaced');
      }
      session = await manager.create({
        viewport: payload.viewport,
        fps: payload.fps,
        quality: payload.quality,
      });
      socket.data.sessionId = session.id;
      session.addClient(socket);
      reply('session:created', session.describe());
      reply('toast', { level: 'ok', message: `Session ready · ${session.viewport.width}×${session.viewport.height}` });
    } catch (err) {
      fail(err);
    }
  });

  socket.on('session:attach', async ({ sessionId } = {}) => {
    try {
      const found = manager.get(sessionId);
      if (!found) throw new Error('session not found');
      if (session && session !== found) session.removeClient(socket.id);
      session = found;
      socket.data.sessionId = session.id;
      session.addClient(socket);
      reply('session:created', session.describe());
    } catch (err) {
      fail(err);
    }
  });

  socket.on('nav', withSession(async (s, { url, hard }) => {
    const res = await s.goto(url, { hard });
    reply('nav:result', res);
  }));

  socket.on('reload', withSession(async (s) => reply('nav:result', await s.forceReload())));

  socket.on('viewport:set', withSession(async (s, { name }) => reply('session:viewport', await s.setViewport(name))));

  socket.on('stream:opts', withSession(async (s, payload) => reply('session:streamOpts', await s.setStreamOpts(payload))));

  socket.on('input', withSession(async (s, payload) => {
    const res = await s.input(payload.kind, payload);
    if (!res.ok && payload.kind !== 'move') reply('input:error', res);
  }));

  socket.on('picker:start', withSession(async (s, { on }) => {
    await s.pickerStart(on !== false);
    clearInterval(pickTimer);
    if (on !== false) {
      pickTimer = setInterval(async () => {
        if (!session || session.destroyed) return clearInterval(pickTimer);
        const res = await session.pickerPoll();
        if (res && res.done) {
          reply('picker:result', { ok: true, element: res.element });
          await session.pickerStart(false);
          clearInterval(pickTimer);
          pickTimer = null;
        }
      }, 600);
    }
  }));

  socket.on('recorder:start', withSession(async (s, { on }) => {
    const res = await s.recorderStart(!!on);
    reply('recorder:state', res);
  }));

  socket.on('recorder:drain', withSession(async (s) => {
    const events = await s.drainRecorder();
    reply('recorder:events', { events, count: events.length });
  }));

  socket.on('recorder:convert', withSession(async (s, { events, targets }) => {
    const out = s.engine.convertRecorded(events || [], targets || []);
    reply('recorder:converted', out);
  }));

  socket.on('engine:run', withSession(async (s, { macro, mode, intervalMs }) => {
    const res = await s.engine.run(macro || {}, { mode, intervalMs });
    reply('engine:result', { action: 'run', ...res });
  }));

  socket.on('engine:stop', withSession(async (s) => {
    s.engine.stop('stopped by user');
    reply('engine:result', { action: 'stop', ok: true });
  }));

  socket.on('rules:run', withSession(async (s, { rules, macro }) => {
    const res = await s.engine.runRules(rules || [], macro || {});
    reply('engine:result', { action: 'rules', ...res });
  }));

  socket.on('rules:stop', withSession(async (s) => {
    s.engine.stopRules();
    reply('engine:result', { action: 'rules-stop', ok: true });
  }));

  socket.on('refresh:auto', withSession(async (s, opts) => setAutoRefresh(s, opts)));

  // One-shot utility (autofill / cookies / storage / screenshot / js)
  socket.on('quick:step', withSession(async (s, { step, macro }) => {
    const m = Object.assign({ name: 'quick action', targets: [] }, macro || {}, { steps: [step] });
    const res = await s.engine.run(m, { mode: 'once' });
    reply('engine:result', { action: 'quick', ...res });
  }));

  socket.on('ping:state', () => reply('session:state', session ? session.describe() : null));

  socket.on('disconnect', () => {
    clearInterval(pickTimer);
    if (session) {
      session.removeClient(socket.id);
      socket.data.sessionId = null;
    }
  });
});

/* ------------------------------------------------------------------ */
/* lifecycle                                                           */
/* ------------------------------------------------------------------ */
server.listen(config.port, config.host, () => {
  console.log(
    `[webmacro] listening on http://${config.host}:${config.port} · fps=${config.fps} quality=${config.quality} viewport=${config.defaultViewport}`
  );
  console.log(`[webmacro] data dir: ${config.dataDir}`);
  // Warm the browser so the first viewer tab is instant.
  require('./browser')
    .getBrowser()
    .then(() => console.log('[webmacro] chromium ready'))
    .catch((err) => console.error('[webmacro] chromium warmup failed:', err.message));
});

async function shutdown(signal) {
  console.log(`[webmacro] ${signal} received — shutting down`);
  try {
    await manager.destroyAll();
    await closeBrowser();
  } catch (_) {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => console.error('[webmacro] unhandled rejection:', err));
