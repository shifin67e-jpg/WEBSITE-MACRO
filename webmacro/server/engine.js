'use strict';
/**
 * Macro + conditional "IF THIS THEN THAT" engine.
 *
 *   macro.steps  -> linear action sequence (humanized)
 *   macro.rules  -> edge-triggered condition watchers (then / else branches)
 *   step.branch  -> inline nested IF/ELSE inside any sequence
 */
const config = require('./config');
const { sleep, randInt, truncate, normalizeUrl } = require('./util');

/* ------------------------------------------------------------------ */
/* step catalogue (mirrored by the UI)                                 */
/* ------------------------------------------------------------------ */
const STEP_TYPES = [
  { type: 'click-target', label: 'Click Target', fields: ['targetId'] },
  { type: 'click-point', label: 'Click Point (x,y)', fields: ['x', 'y'] },
  { type: 'click-selector', label: 'Click Element (selector)', fields: ['selector'] },
  { type: 'type', label: 'Type Text', fields: ['selector', 'text'] },
  { type: 'press', label: 'Press Key', fields: ['key'] },
  { type: 'goto', label: 'Navigate To URL', fields: ['url'] },
  { type: 'wait', label: 'Wait (ms)', fields: ['ms'] },
  { type: 'wait-random', label: 'Humanized Wait (min–max ms)', fields: ['min', 'max'] },
  { type: 'wait-for', label: 'Wait For Element', fields: ['selector', 'state', 'timeout'] },
  { type: 'scroll', label: 'Scroll', fields: ['dy', 'mode'] },
  { type: 'refresh', label: 'Refresh Page', fields: ['hard'] },
  { type: 'cookies', label: 'Inject Cookies (JSON)', fields: ['json'] },
  { type: 'storage', label: 'Inject LocalStorage (JSON)', fields: ['json'] },
  { type: 'autofill', label: 'Autofill Form (JSON)', fields: ['json'] },
  { type: 'screenshot', label: 'Capture Screenshot', fields: [] },
  { type: 'js', label: 'Run JavaScript', fields: ['code'] },
  { type: 'branch', label: 'IF / ELSE Branch', fields: ['condition', 'then', 'else'] },
];

const CONDITION_TYPES = [
  { type: 'text', label: 'Element text equals / contains', fields: ['selector', 'op', 'value'] },
  { type: 'text-change', label: 'Element text changes to', fields: ['selector', 'value'] },
  { type: 'visible', label: 'Element appears / visible', fields: ['selector', 'state'] },
  { type: 'enabled', label: 'Button becomes enabled', fields: ['selector'] },
  { type: 'url', label: 'URL contains / equals', fields: ['op', 'value'] },
  { type: 'js', label: 'Custom JS expression is truthy', fields: ['code'] },
  { type: 'all', label: 'ALL of (AND)', fields: ['conditions'] },
  { type: 'any', label: 'ANY of (OR)', fields: ['conditions'] },
  { type: 'not', label: 'NOT', fields: ['condition'] },
];

class Engine {
  constructor(session) {
    this.session = session;
    this.running = false;
    this.ruleLoop = false;
    this.current = { name: null, kind: null, index: 0, total: 0 };
    this.iteration = 0;
    this.ruleStates = new Map();
    this.textMemory = new Map();
    this._stop = false;
    this._ruleTimer = null;
  }

  get page() {
    return this.session.page;
  }

  describe() {
    return {
      running: this.running,
      ruleLoop: this.ruleLoop,
      current: { ...this.current },
      iteration: this.iteration,
    };
  }

  log(level, message) {
    this.session.log(level, `[engine] ${message}`);
  }

  stop(reason = 'stopped') {
    this._stop = true;
    this.running = false;
    this.ruleLoop = false;
    if (this._ruleTimer) clearTimeout(this._ruleTimer);
    this._ruleTimer = null;
    this.current = { name: null, kind: null, index: 0, total: 0 };
    this.log('info', `Engine ${reason}.`);
    this.session.syncState({ reason: 'engine' });
  }

  /* ---------------------------------------------------------------- */
  /* humanization helpers                                             */
  /* ---------------------------------------------------------------- */
  get humanize() {
    return { ...config.humanizeDefaults, ...(this._macro && this._macro.humanize) };
  }

  async humanPause(multiplier = 1) {
    const h = this.humanize;
    if (!h.enabled) return;
    const ms = randInt(h.minDelay, h.maxDelay) * multiplier;
    await this._sleepInterruptible(ms);
  }

  async _sleepInterruptible(ms) {
    const end = Date.now() + ms;
    while (!this._stop && Date.now() < end) {
      await sleep(Math.min(250, end - Date.now()));
    }
  }

  /* ---------------------------------------------------------------- */
  /* run a macro: once, or on a loop                                  */
  /* ---------------------------------------------------------------- */
  async run(macro, opts = {}) {
    if (this.running) return { ok: false, error: 'engine already running' };
    this._macro = macro || {};
    this._stop = false;
    this.running = true;
    this.iteration = 0;
    const targets = new Map((macro.targets || []).map((t) => [t.id, t]));

    const mode = opts.mode === 'loop' ? 'loop' : 'once';
    const intervalMs = Math.max(1000, Number(opts.intervalMs) || 30000);
    this.log('info', `Run "${macro.name || 'macro'}" (${mode}) · ${(macro.steps || []).length} step(s)`);
    this.session.syncState({ reason: 'engine-run' });

    try {
      do {
        this.iteration++;
        this.current = { name: macro.name || 'macro', kind: mode, index: 0, total: (macro.steps || []).length };
        await this.execSteps(macro.steps || [], { targets, macro });
        if (mode === 'once') break;
        this.log('info', `Loop #${this.iteration} complete — next in ${Math.round(intervalMs / 1000)}s`);
        await this._sleepInterruptible(intervalMs);
      } while (!this._stop && mode === 'loop');
      return { ok: true, iterations: this.iteration };
    } catch (err) {
      this.log('error', `Run aborted: ${truncate(err.message, 160)}`);
      return { ok: false, error: String(err.message || err) };
    } finally {
      this.running = false;
      this.current = { name: null, kind: null, index: 0, total: 0 };
      this.session.syncState({ reason: 'engine-done' });
    }
  }

  async execSteps(steps, ctx, depth = 0) {
    if (depth > 6) {
      this.log('warn', 'Branch nesting too deep — stopping recursion.');
      return;
    }
    for (let i = 0; i < steps.length; i++) {
      if (this._stop) return;
      const step = steps[i];
      this.current = { ...this.current, index: i + 1, total: steps.length };
      this.session.syncState({ reason: 'engine-step' });
      try {
        await this.execStep(step, ctx, depth);
      } catch (err) {
        this.log('error', `Step ${i + 1} (${step.type}) failed: ${truncate(err.message, 120)}`);
        if (!step.continueOnError) throw err;
      }
    }
  }

  async execStep(step, ctx, depth = 0) {
    const page = this.page;
    if (!page || page.isClosed()) throw new Error('page not available');
    const t = step.type;

    this.log(
      'info',
      `Step ${this.current.index}/${this.current.total}: ${t}${step.label ? ` — ${step.label}` : ''}`
    );

    switch (t) {
      case 'click-target': {
        const target = ctx.targets.get(step.targetId);
        if (!target) throw new Error(`target ${step.targetId} not found`);
        const point = resolveTargetPoint(target);
        if (point) {
          await page.mouse.click(point.x, point.y, { delay: randInt(20, 70) });
          this.log('info', `Clicked target "${target.name || target.id}" at ${point.x},${point.y}`);
        } else if (target.selector) {
          await page.locator(target.selector).first().click({ timeout: 10000 });
        } else {
          throw new Error('target has neither box nor selector');
        }
        break;
      }
      case 'click-point':
        await page.mouse.click(Number(step.x) || 0, Number(step.y) || 0, { delay: randInt(20, 70) });
        break;
      case 'click-selector':
        await page.locator(step.selector).first().click({ timeout: Number(step.timeout) || 10000 });
        break;
      case 'type': {
        const loc = page.locator(step.selector).first();
        await loc.click({ timeout: 10000 });
        await this.typeHuman(step.text || '');
        break;
      }
      case 'press':
        await page.keyboard.press(step.key || 'Enter');
        break;
      case 'goto':
        await page.goto(normalizeUrl(step.url), { waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs });
        break;
      case 'wait':
        await this._sleepInterruptible(Number(step.ms) || 1000);
        break;
      case 'wait-random':
        await this._sleepInterruptible(randInt(Number(step.min) || 1500, Number(step.max) || 4000));
        break;
      case 'wait-for':
        await page.locator(step.selector).first().waitFor({
          state: step.state || 'visible',
          timeout: Number(step.timeout) || 30000,
        });
        break;
      case 'scroll':
        if (step.mode === 'bottom') await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        else if (step.mode === 'top') await page.evaluate(() => window.scrollTo(0, 0));
        else await page.evaluate((dy) => window.scrollBy(0, dy), Number(step.dy) || 600);
        break;
      case 'refresh':
        if (step.hard) await page.reload({ waitUntil: 'load' });
        else await page.reload({ waitUntil: 'domcontentloaded' });
        break;
      case 'cookies': {
        const raw = parseJson(step.json, []);
        const cookies = (Array.isArray(raw) ? raw : raw.cookies || []).map((c) => {
          const out = { ...c };
          if (!out.url && !out.domain) out.url = page.url();
          return out;
        });
        if (cookies.length) await this.session.context.addCookies(cookies);
        this.log('info', `Injected ${cookies.length} cookie(s).`);
        break;
      }
      case 'storage': {
        const data = parseJson(step.json, {});
        await page.evaluate((kv) => {
          for (const k of Object.keys(kv)) localStorage.setItem(k, String(kv[k]));
        }, data);
        this.log('info', `Wrote ${Object.keys(data).length} localStorage key(s).`);
        break;
      }
      case 'autofill':
        await this.autofill(parseJson(step.json, {}));
        break;
      case 'screenshot': {
        const buf = await this.session.snapshot();
        if (buf) this.log('info', `Screenshot captured (${Math.round(buf.length / 1024)} KB).`);
        break;
      }
      case 'js':
        await page.evaluate(step.code || 'void 0');
        break;
      case 'branch': {
        const ok = await this.evalCondition(step.condition);
        this.log('info', `Branch → ${ok ? 'THEN' : 'ELSE'}`);
        await this.execSteps(ok ? step.then || [] : step.else || [], ctx, depth + 1);
        break;
      }
      default:
        this.log('warn', `Unknown step type "${t}" skipped.`);
        return;
    }

    if (t !== 'wait' && t !== 'wait-random' && t !== 'branch') await this.humanPause(0.35);
  }

  async typeHuman(text) {
    const h = this.humanize;
    if (!h.enabled) {
      await this.page.keyboard.type(String(text));
      return;
    }
    for (const ch of String(text)) {
      await this.page.keyboard.type(ch);
      await sleep(randInt(h.typingMin, h.typingMax));
    }
  }

  async autofill(data) {
    const entries = Object.entries(data || {});
    let filled = 0;
    for (const [key, value] of entries) {
      const candidates = [
        key.startsWith('#') || key.startsWith('.') || key.startsWith('[') ? key : null,
        `[name="${key}"]`,
        `#${key}`,
        `[placeholder*="${key}" i]`,
        `[aria-label*="${key}" i]`,
        `[id*="${key}" i]`,
      ].filter(Boolean);
      let done = false;
      for (const sel of candidates) {
        try {
          const loc = this.page.locator(sel).first();
          if ((await loc.count()) > 0 && (await loc.isVisible())) {
            await loc.fill(String(value), { timeout: 4000 });
            filled++;
            done = true;
            break;
          }
        } catch (_) {}
      }
      if (!done) this.log('warn', `Autofill: no field matched "${key}"`);
    }
    this.log('info', `Autofill complete — ${filled}/${entries.length} field(s).`);
  }

  /* ---------------------------------------------------------------- */
  /* conditional rules (edge-triggered IF/ELSE)                        */
  /* ---------------------------------------------------------------- */
  async runRules(rules, macro) {
    if (this.ruleLoop) return { ok: false, error: 'rule loop already running' };
    this._macro = macro || {};
    this.ruleLoop = true;
    this._stop = false;
    this.log('info', `Conditional engine armed with ${rules.length} rule(s).`);
    this.session.syncState({ reason: 'rules-start' });
    const tick = async () => {
      if (!this.ruleLoop || this._stop) return;
      for (const rule of rules) {
        if (rule.enabled === false || this._stop) continue;
        await this.tickRule(rule, macro).catch((e) =>
          this.log('error', `Rule "${rule.name}" error: ${truncate(e.message, 120)}`)
        );
      }
      this._ruleTimer = setTimeout(tick, config.pollMs);
    };
    tick();
    return { ok: true };
  }

  stopRules() {
    this.ruleLoop = false;
    if (this._ruleTimer) clearTimeout(this._ruleTimer);
    this._ruleTimer = null;
    this.session.syncState({ reason: 'rules-stop' });
  }

  async tickRule(rule, macro) {
    const stateKey = rule.id;
    const prev = this.ruleStates.get(stateKey) || { truthy: false, firedCount: 0, lastFire: 0, lastText: null };
    const result = await this.evalCondition(rule.condition, prev);

    const fired = result.truthy !== prev.truthy;
    const cooldownOk = Date.now() - prev.lastFire > (Number(rule.cooldownMs) || 0);

    let truthy = prev.truthy;
    let firedCount = prev.firedCount;
    let lastFire = prev.lastFire;
    const lastText = result.text !== undefined ? result.text : prev.lastText;

    if (fired && cooldownOk && !this.running) {
      const branch = result.truthy ? rule.then || [] : rule.else || [];
      truthy = result.truthy;
      if (branch.length) {
        this.log('info', `Rule "${rule.name || rule.id}" → ${truthy ? 'THEN' : 'ELSE'} (${branch.length} step(s))`);
        const ctx = { targets: new Map((macro && macro.targets || []).map((t) => [t.id, t])), macro };
        await this.execSteps(branch, ctx);
      }
      firedCount++;
      lastFire = Date.now();
      if (rule.once && truthy) this.log('info', `Rule "${rule.name}" is one-shot — consider disabling.`);
      this.session.emit('rule:fired', { ruleId: rule.id, name: rule.name, branch: truthy ? 'then' : 'else', at: lastFire });
    }

    this.ruleStates.set(stateKey, { truthy, firedCount, lastFire, lastText });
  }

  /**
   * Evaluate one condition. Returns { truthy, text? }
   */
  async evalCondition(cond, prev = {}) {
    if (!cond || !cond.type) return { truthy: false };
    const page = this.page;
    if (!page || page.isClosed()) return { truthy: false };

    const textOf = async (selector) => {
      try {
        const loc = page.locator(selector).first();
        if ((await loc.count()) === 0) return null;
        return ((await loc.innerText({ timeout: 2500 })) || '').replace(/\s+/g, ' ').trim();
      } catch (_) {
        return null;
      }
    };

    switch (cond.type) {
      case 'text': {
        const text = await textOf(cond.selector);
        if (text === null) return { truthy: false, text: null };
        const v = String(cond.value || '');
        const op = cond.op || 'contains';
        const truthy =
          op === 'equals'
            ? text === v
            : op === 'contains'
            ? text.includes(v)
            : op === 'notEquals'
            ? text !== v
            : op === 'startsWith'
            ? text.startsWith(v)
            : new RegExp(v).test(text);
        return { truthy, text };
      }
      case 'text-change': {
        const text = await textOf(cond.selector);
        if (text === null) return { truthy: false, text: null };
        const changed = text !== prev.lastText;
        const matches = String(cond.value || '') ? text.includes(String(cond.value)) : true;
        return { truthy: changed && matches, text };
      }
      case 'visible': {
        const state = cond.state || 'visible';
        const loc = page.locator(cond.selector).first();
        const count = await loc.count().catch(() => 0);
        if (count === 0) return { truthy: state === 'hidden' || state === 'exists' ? false : state === 'detached' };
        let truthy = false;
        if (state === 'visible') truthy = await loc.isVisible().catch(() => false);
        else if (state === 'hidden') truthy = !(await loc.isVisible().catch(() => false));
        else if (state === 'exists') truthy = true;
        else if (state === 'detached') truthy = false;
        return { truthy };
      }
      case 'enabled': {
        const loc = page.locator(cond.selector).first();
        const count = await loc.count().catch(() => 0);
        if (!count) return { truthy: false };
        const enabled = await loc.isEnabled().catch(() => false);
        return { truthy: cond.invert ? !enabled : enabled };
      }
      case 'url': {
        const url = page.url();
        const v = String(cond.value || '');
        return { truthy: (cond.op || 'contains') === 'equals' ? url === v : url.includes(v) };
      }
      case 'js': {
        try {
          const truthy = await page.evaluate(`(()=>{ try { return !!(${cond.code}); } catch(e){ return false; } })()`);
          return { truthy: !!truthy };
        } catch (_) {
          return { truthy: false };
        }
      }
      case 'all': {
        const results = [];
        for (const c of cond.conditions || []) results.push(await this.evalCondition(c, prev));
        return { truthy: results.length > 0 && results.every((r) => r.truthy), text: results.map((r) => r.text).find((x) => x != null) };
      }
      case 'any': {
        const results = [];
        for (const c of cond.conditions || []) results.push(await this.evalCondition(c, prev));
        return { truthy: results.some((r) => r.truthy) };
      }
      case 'not': {
        const r = await this.evalCondition(cond.condition, prev);
        return { truthy: !r.truthy, text: r.text };
      }
      default:
        return { truthy: false };
    }
  }

  /* ---------------------------------------------------------------- */
  /* recorded event -> editable steps                                 */
  /* ---------------------------------------------------------------- */
  convertRecorded(events, targets) {
    // Map every recorded element onto a reusable pinned target so re-runs
    // survive small layout shifts.
    const targetList = [...(targets || [])];
    const steps = [];
    const keyOf = (d) => (d && (d.selector || d.xpath)) || 'unknown';
    const findOrAdd = (d) => {
      if (!d) return null;
      const existing = targetList.find((t) => (t.selector || t.xpath) === keyOf(d));
      if (existing) return existing.id;
      const t = {
        id: `tgt_rec_${targetList.length + 1}`,
        name: `${d.tag || 'el'} "${truncate(d.text || d.selector || '', 24)}"`,
        kind: 'element',
        selector: d.selector || null,
        xpath: d.xpath || null,
        text: d.text || null,
        box: d.rect
          ? { x1: Math.round(d.rect.x), y1: Math.round(d.rect.y), x2: Math.round(d.rect.x + d.rect.width), y2: Math.round(d.rect.y + d.rect.height) }
          : null,
        jitter: 0,
        recorded: true,
      };
      targetList.push(t);
      return t.id;
    };

    let lastScrollY = 0;
    let lastKeyAt = 0;
    for (const ev of events) {
      switch (ev.type) {
        case 'click': {
          const targetId = findOrAdd(ev.data);
          steps.push({ type: 'click-target', targetId });
          break;
        }
        case 'fill': {
          const d = ev.data;
          if (d && d.selector) steps.push({ type: 'type', selector: d.selector, text: String(ev.value || '') });
          break;
        }
        case 'key': {
          if (Date.now() - lastKeyAt < 400) break;
          lastKeyAt = Date.now();
          const combo = [ev.ctrl && 'Control', ev.shift && 'Shift', ev.alt && 'Alt', ev.meta && 'Meta', ev.key]
            .filter(Boolean)
            .join('+');
          if (combo && combo !== '+') steps.push({ type: 'press', key: combo });
          break;
        }
        case 'scroll': {
          if (ev.dy === undefined) break;
          const dy = Math.round(ev.dy - lastScrollY);
          lastScrollY = ev.dy;
          if (Math.abs(dy) > 60) steps.push({ type: 'scroll', dy });
          break;
        }
        case 'submit':
          steps.push({ type: 'press', key: 'Enter' });
          break;
        default:
          break;
      }
    }
    // Insert humanized waits between every action so replays do not look robotic.
    const spaced = [];
    steps.forEach((s, i) => {
      spaced.push(s);
      if (i < steps.length - 1 && /click|type|press|scroll/.test(s.type)) {
        spaced.push({ type: 'wait-random', min: 1500, max: 4000 });
      }
    });
    return { steps: spaced, targets: targetList };
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */
function resolveTargetPoint(target) {
  if (target.kind === 'element' && target.box) return boxPoint(target.box, target.jitter);
  if (target.box) return boxPoint(target.box, target.jitter);
  if (target.point) return { x: target.point.x, y: target.point.y };
  return null;
}

function boxPoint(box, jitter = 0) {
  const x1 = Math.min(box.x1, box.x2);
  const x2 = Math.max(box.x1, box.x2);
  const y1 = Math.min(box.y1, box.y2);
  const y2 = Math.max(box.y1, box.y2);
  const j = Math.max(0, Number(jitter) || 0);
  // stay inside the box and away from the exact edges
  const inset = Math.max(1, j);
  const px = randInt(x1 + inset, Math.max(x1 + inset, x2 - inset));
  const py = randInt(y1 + inset, Math.max(y1 + inset, y2 - inset));
  return { x: px, y: py };
}

function parseJson(text, fallback) {
  if (text === undefined || text === null || text === '') return fallback;
  if (typeof text === 'object') return text;
  try {
    return JSON.parse(text);
  } catch (_) {
    return fallback;
  }
}

module.exports = Engine;
module.exports.STEP_TYPES = STEP_TYPES;
module.exports.CONDITION_TYPES = CONDITION_TYPES;
module.exports.resolveTargetPoint = resolveTargetPoint;
