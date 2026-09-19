const socket = io();

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const rnd = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

function toast(msg, kind = '') {
  const wrap = $('#toasts');
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = msg;
  wrap.appendChild(node);
  setTimeout(() => node.remove(), 3200);
}

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'value') node.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') node[k] = !!v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return node;
}

const fmt = {
  coord: (b) => (b ? `${Math.round(b.x1)},${Math.round(b.y1)} → ${Math.round(b.x2)},${Math.round(b.y2)}` : '—'),
  ms: (ms) => (ms >= 60000 ? `${Math.round(ms / 60000)}m` : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`),
  time: (t) => new Date(t).toLocaleTimeString(),
};

const state = {
  meta: null,
  sessionId: null,
  viewport: { width: 390, height: 844 },
  zoom: 1,
  fit: 1,
  fps: 0,
  clients: 0,
  url: 'about:blank',
  title: '',
  picking: false,
  recording: false,
  autoRefresh: { enabled: false, intervalMs: 60000, hard: false, jitterMs: 2500 },
  humanize: { enabled: true, minDelay: 1500, maxDelay: 4000, typingMin: 60, typingMax: 190 },
  targets: [],
  steps: [],
  rules: [],
  events: [],
  macroId: null,
  macroName: 'Untitled macro',
  startUrl: 'https://example.com',
  autofill: '{\n  "email": "user@example.com",\n  "password": "hunter2"\n}',
  cookies: '[\n  {\n    "name": "session",\n    "value": "abc123",\n    "domain": "example.com",\n    "path": "/"\n  }\n]',
  storage: '{\n  "featureFlag": "on"\n}',
};

/* ================================================================== */
/* socket                                                             */
/* ================================================================== */
socket.on('connect', () => {
  socket.emit('session:create', { viewport: 'phone' });
});

socket.on('toast', (p) => toast(p.message, p.level === 'ok' ? 'ok' : ''));
socket.on('error:msg', (p) => toast(p.message, 'err'));

socket.on('session:created', (s) => {
  state.sessionId = s.sessionId;
  state.viewport = s.viewport;
  state.fps = s.fps || state.fps;
  state.url = s.url;
  state.title = s.title;
  resizeCanvas();
  renderStatus();
  console.log('[session]', s);
});

socket.on('session:viewport', (p) => {
  if (p.viewport) state.viewport = p.viewport;
  resizeCanvas();
  renderStatus();
});

socket.on('session:streamOpts', (p) => {
  state.fps = p.fps;
  renderStatus();
});

socket.on('session:state', (s) => {
  if (!s) return;
  state.viewport = s.viewport || state.viewport;
  state.url = s.url || state.url;
  state.title = s.title || '';
  state.fps = s.fpsMeasured || state.fps;
  state.picking = !!s.picking;
  state.recording = !!s.recording;
  renderStatus();
  renderPills();
});

socket.on('session:log', (entry) => appendLog(entry));
socket.on('session:logs', (entries) => {
  const box = $('#log');
  box.innerHTML = '';
  entries.forEach(appendLog);
});

socket.on('nav:result', (r) => {
  if (r && r.ok) {
    state.url = r.url;
    $('#address').value = r.url;
    renderStatus();
  } else if (r && r.error) {
    toast(`Navigation error: ${r.error}`, 'err');
  }
});

socket.on('input:error', (r) => toast(r.error || 'input failed', 'err'));

socket.on('picker:result', (p) => {
  if (!p || !p.element) return;
  addTarget(fromElement(p.element));
  socket.emit('picker:start', { on: false });
  setPicking(false);
  toast('Element captured', 'ok');
});

socket.on('recorder:state', (r) => setRecording(!!r.on));

socket.on('recorder:events', (r) => {
  if (!r || !r.events) return;
  if (r.events.length) {
    state.events = state.events.concat(r.events);
    renderRecorder();
  }
});

socket.on('recorder:converted', (r) => {
  if (!r) return;
  state.targets = r.targets || state.targets;
  state.steps = (state.steps || []).concat(r.steps || []);
  renderTargets();
  renderSteps();
  toast(`Converted ${(r.steps || []).length} step(s)`, 'ok');
});

socket.on('engine:result', (r) => {
  if (r && r.action === 'run' && r.ok) toast(`Run complete · ${r.iterations || 1} iteration(s)`, 'ok');
  if (r && r.action === 'rules') toast('Conditional engine armed', 'ok');
  if (r && r.error) toast(r.error, 'err');
  renderEngineStatus();
});

socket.on('rule:fired', (r) => {
  toast(`Rule "${r.name || r.ruleId}" fired → ${r.branch.toUpperCase()}`);
  renderEngineStatus();
});

socket.on('refresh:state', (p) => {
  state.autoRefresh = { ...state.autoRefresh, ...p };
  renderAutoRefresh();
});

/* ---- streaming frames ------------------------------------------- */
let lastFrameUrl = null;
const canvas = $('#canvas');
const ctx = canvas.getContext('2d', { alpha: false });

socket.on('frame', (meta, buf) => {
  const blob = new Blob([buf], { type: 'image/jpeg' });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    if (canvas.width !== meta.w || canvas.height !== meta.h) {
      canvas.width = meta.w;
      canvas.height = meta.h;
      resizeCanvas();
    }
    ctx.drawImage(img, 0, 0, meta.w, meta.h);
    if (lastFrameUrl) URL.revokeObjectURL(lastFrameUrl);
    lastFrameUrl = url;
  };
  img.onerror = () => URL.revokeObjectURL(url);
  img.src = url;
  state.fps = state.fps || 0;
  paintFps();
});

/* ================================================================== */
/* view switching                                                     */
/* ================================================================== */
$$('.tab').forEach((tab) =>
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
    $$('.view').forEach((v) => v.classList.toggle('is-active', v.id === `view-${tab.dataset.view}`));
    if (tab.dataset.view === 'viewer') resizeCanvas();
  })
);

/* ================================================================== */
/* canvas sizing / zoom / fullscreen                                  */
/* ================================================================== */
const wrap = $('#canvasWrap');

function resizeCanvas() {
  const avail = wrap.clientWidth - 2;
  const ratio = state.viewport.height / state.viewport.width;
  const w = Math.max(120, avail * state.zoom);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${Math.round(w * ratio)}px`;
  $('#zoomLabel').textContent = `${Math.round(state.zoom * 100)}%`;
}

function setZoom(z) {
  state.zoom = clamp(z, 0.5, 3);
  resizeCanvas();
  toast(`Zoom ${Math.round(state.zoom * 100)}%`);
}

window.addEventListener('resize', () => {
  if ($('#view-viewer').classList.contains('is-active')) resizeCanvas();
});

$('#btnZoomIn').addEventListener('click', () => setZoom(state.zoom + 0.25));
$('#btnZoomOut').addEventListener('click', () => setZoom(state.zoom - 0.25));
$('#btnZoomReset').addEventListener('click', () => setZoom(1));
$('#btnReload').addEventListener('click', () => socket.emit('reload'));

$('#btnFullscreen').addEventListener('click', async () => {
  try {
    if (!document.fullscreenElement) await wrap.requestFullscreen();
    else await document.exitFullscreen();
  } catch (e) {
    toast('Fullscreen unavailable', 'err');
  }
});
document.addEventListener('fullscreenchange', () => {
  $('#btnFullscreen').classList.toggle('is-active', !!document.fullscreenElement);
  setTimeout(resizeCanvas, 120);
});

$('#btnGo').addEventListener('click', go);
$('#address').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') go();
});
function go() {
  const url = $('#address').value.trim();
  if (!url) return toast('Enter a URL', 'err');
  socket.emit('nav', { url });
}

/* ---- viewport presets -------------------------------------------- */
function renderPresets() {
  const box = $('#presets');
  box.innerHTML = '';
  const names = [
    ['phone-xs', 'XS'],
    ['phone', 'Phone'],
    ['phone-lg', 'L'],
    ['landscape', 'Land'],
    ['tablet', 'Tablet'],
    ['laptop', 'Laptop'],
    ['desktop', 'Desktop'],
  ];
  names.forEach(([name, label]) =>
    box.appendChild(
      h(
        'button',
        {
          class: 'pill tiny',
          onclick: (e) => {
            socket.emit('viewport:set', { name });
            $$('#presets .pill').forEach((p) => p.classList.remove('is-active'));
            e.currentTarget.classList.add('is-active');
          },
        },
        label
      )
    )
  );
}

/* ---- pointer -> server input ------------------------------------- */
let pointer = null;
let scrollAccum = 0;
let scrollTimer = null;

function toPage(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  return {
    x: clamp((clientX - r.left) / r.width, 0, 1) * state.viewport.width,
    y: clamp((clientY - r.top) / r.height, 0, 1) * state.viewport.height,
    w: state.viewport.width,
    h: state.viewport.height,
  };
}

canvas.addEventListener('pointerdown', (e) => {
  if (wrap.classList.contains('is-cropping')) return;
  pointer = { x: e.clientX, y: e.clientY, moved: 0, t: Date.now(), lastY: e.clientY, scroll: 0 };
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
  if (!pointer) return;
  const dy = e.clientY - pointer.lastY;
  pointer.lastY = e.clientY;
  pointer.moved += Math.abs(e.clientX - pointer.x) + Math.abs(dy);
  pointer.scroll -= dy;
  scrollAccum -= dy;
  if (!scrollTimer && Math.abs(scrollAccum) > 6) {
    scrollTimer = setTimeout(() => {
      const p = toPage(pointer.x, pointer.y);
      socket.emit('input', { kind: 'scroll', dy: scrollAccum, x: p.x, y: p.y, w: p.w, h: p.h });
      scrollAccum = 0;
      scrollTimer = null;
    }, 90);
  }
});

canvas.addEventListener('pointerup', (e) => {
  if (!pointer) return;
  const quick = Date.now() - pointer.t < 450;
  const steady = pointer.moved < 12;
  const p = toPage(e.clientX, e.clientY);
  if (quick && steady) socket.emit('input', { kind: 'tap', x: p.x, y: p.y, w: p.w, h: p.h });
  pointer = null;
  scrollAccum = 0;
  if (scrollTimer) {
    clearTimeout(scrollTimer);
    scrollTimer = null;
  }
});
canvas.addEventListener('pointercancel', () => (pointer = null));

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const p = toPage(e.clientX, e.clientY);
    socket.emit('input', { kind: 'wheel', x: p.x, y: p.y, dx: e.deltaX, dy: e.deltaY, w: p.w, h: p.h });
  },
  { passive: false }
);

/* ---- keyboard bar ------------------------------------------------ */
$('#btnKeySend').addEventListener('click', () => {
  const text = $('#textInput').value;
  if (!text) return;
  socket.emit('input', { kind: 'type', text });
  $('#textInput').value = '';
});
[['Enter', '⏎'], ['Backspace', '⌫'], ['Tab', 'Tab'], ['Escape', 'Esc'], ['Space', '␣']].forEach(([key, label]) => {
  $('#keyRow').appendChild(
    h('button', { class: 'pill tiny', onclick: () => socket.emit('input', { kind: 'key', key }) }, label)
  );
});

/* ================================================================== */
/* crop hitbox selector                                               */
/* ================================================================== */
const cropLayer = $('#cropLayer');
const cropRect = $('#cropRect');
let cropStart = null;

$('#btnCrop').addEventListener('click', () => {
  const on = !wrap.classList.contains('is-cropping');
  setCropping(on);
  if (on) toast('Drag on the preview to draw a hitbox');
});

function setCropping(on) {
  wrap.classList.toggle('is-cropping', on);
  $('#btnCrop').classList.toggle('is-active', on);
  $('#cropNote').style.display = on ? 'block' : 'none';
  if (!on) {
    cropRect.style.display = 'none';
    cropStart = null;
  }
}

cropLayer.addEventListener('pointerdown', (e) => {
  const r = wrap.getBoundingClientRect();
  cropStart = { x: e.clientX - r.left + wrap.scrollLeft, y: e.clientY - r.top + wrap.scrollTop };
  cropRect.style.display = 'block';
  cropRect.style.left = `${cropStart.x}px`;
  cropRect.style.top = `${cropStart.y}px`;
  cropRect.style.width = '0px';
  cropRect.style.height = '0px';
  cropLayer.setPointerCapture(e.pointerId);
});

cropLayer.addEventListener('pointermove', (e) => {
  if (!cropStart) return;
  const r = wrap.getBoundingClientRect();
  const x = e.clientX - r.left + wrap.scrollLeft;
  const y = e.clientY - r.top + wrap.scrollTop;
  const left = Math.min(x, cropStart.x);
  const top = Math.min(y, cropStart.y);
  cropRect.style.left = `${left}px`;
  cropRect.style.top = `${top}px`;
  cropRect.style.width = `${Math.abs(x - cropStart.x)}px`;
  cropRect.style.height = `${Math.abs(y - cropStart.y)}px`;
});

cropLayer.addEventListener('pointerup', (e) => {
  if (!cropStart) return;
  const r = canvas.getBoundingClientRect();
  const sx = state.viewport.width / r.width;
  const sy = state.viewport.height / r.height;
  const a = cropStart;
  const b = { x: e.clientX - wrap.getBoundingClientRect().left + wrap.scrollLeft, y: e.clientY - wrap.getBoundingClientRect().top + wrap.scrollTop };
  const w = Math.abs(b.x - a.x);
  const hgt = Math.abs(b.y - a.y);
  cropStart = null;
  if (w < 8 || hgt < 8) {
    cropRect.style.display = 'none';
    return toast('Hitbox too small', 'err');
  }
  const box = {
    x1: Math.round((Math.min(a.x, b.x) - (r.left - wrap.getBoundingClientRect().left)) * sx),
    y1: Math.round((Math.min(a.y, b.y) - (r.top - wrap.getBoundingClientRect().top)) * sy),
    x2: Math.round((Math.max(a.x, b.x) - (r.left - wrap.getBoundingClientRect().left)) * sx),
    y2: Math.round((Math.max(a.y, b.y) - (r.top - wrap.getBoundingClientRect().top)) * sy),
  };
  box.x1 = clamp(box.x1, 0, state.viewport.width);
  box.x2 = clamp(box.x2, 0, state.viewport.width);
  box.y1 = clamp(box.y1, 0, state.viewport.height);
  box.y2 = clamp(box.y2, 0, state.viewport.height);
  cropRect.style.display = 'none';
  setCropping(false);
  const target = {
    id: `tgt_${Date.now().toString(36)}`,
    name: `Hitbox ${state.targets.length + 1}`,
    kind: 'hitbox',
    box,
    jitter: Math.max(2, Math.round(Math.min(box.x2 - box.x1, box.y2 - box.y1) * 0.2)),
    selector: null,
    xpath: null,
  };
  addTarget(target);
  toast('Hitbox target added', 'ok');
});

/* ================================================================== */
/* targets                                                            */
/* ================================================================== */
function fromElement(el) {
  return {
    id: `tgt_${Date.now().toString(36)}`,
    name: `${el.tag}${el.text ? ` "${el.text.slice(0, 22)}"` : el.id ? `#${el.id}` : ''}`,
    kind: 'element',
    selector: el.selector || null,
    xpath: el.xpath || null,
    text: el.text || null,
    id_attr: el.id || null,
    classes: el.classes || null,
    box: el.rect ? { x1: Math.round(el.rect.x), y1: Math.round(el.rect.y), x2: Math.round(el.rect.x + el.rect.width), y2: Math.round(el.rect.y + el.rect.height) } : null,
    jitter: 0,
    raw: el,
  };
}

function addTarget(t) {
  state.targets.push(t);
  renderTargets();
}

function setPicking(on) {
  state.picking = on;
  $('#btnPick').classList.toggle('is-active', on);
  $('#pickNote').style.display = on ? 'block' : 'none';
}

$('#btnPick').addEventListener('click', () => {
  const on = !state.picking;
  setPicking(on);
  socket.emit('picker:start', { on });
  toast(on ? 'Tap an element in the preview' : 'Picker off');
});

function renderTargets() {
  const box = $('#targetList');
  box.innerHTML = '';
  $('#targetCount').textContent = `${state.targets.length} target(s)`;
  if (!state.targets.length) {
    box.appendChild(h('div', { class: 'empty' }, 'No targets yet — use Crop Hitbox or Smart Element Picker.'));
    return;
  }
  state.targets.forEach((t, i) => {
    const item = h('div', { class: 'item' });
    item.appendChild(
      h(
        'div',
        { class: 'item-head' },
        h('div', { class: 'item-title' }, `${i + 1}. ${t.name}`),
        h('span', { class: 'badge' }, t.kind === 'element' ? 'ELEMENT' : 'HITBOX')
      )
    );
    item.appendChild(h('div', { class: 'badge', style: 'align-self:flex-start' }, t.kind === 'element' ? t.selector || t.xpath || '—' : fmt.coord(t.box)));
    if (t.box) item.appendChild(h('div', { class: 'badge', style: 'align-self:flex-start' }, `box ${fmt.coord(t.box)}`));

    item.appendChild(
      h(
        'div',
        { class: 'row' },
        h('label', { class: 'field grow', style: 'min-width:120px' }, 'Name', h('input', { type: 'text', value: t.name, oninput: (e) => (t.name = e.target.value) })),
        h('label', { class: 'field grow', style: 'min-width:96px' }, 'Click jitter px', h('input', { type: 'number', value: t.jitter || 0, min: 0, oninput: (e) => (t.jitter = Number(e.target.value) || 0) }))
      )
    );

    item.appendChild(
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'pill tiny', onclick: () => { socket.emit('input', { kind: 'tap', ...(t.box ? centerOf(t.box) : {}) }); toast('Test tap sent'); } }, 'Test tap'),
        h('button', { class: 'pill tiny', onclick: () => { state.steps.push({ type: 'click-target', targetId: t.id }); renderSteps(); } }, 'Add to macro'),
        h('button', { class: 'pill tiny', onclick: () => { state.targets.splice(i, 1); renderTargets(); } }, 'Delete')
      )
    );
    box.appendChild(item);
  });
}

function centerOf(box) {
  return { x: (box.x1 + box.x2) / 2, y: (box.y1 + box.y2) / 2, w: state.viewport.width, h: state.viewport.height };
}

/* ================================================================== */
/* recorder                                                           */
/* ================================================================== */
function setRecording(on) {
  state.recording = on;
  $('#btnRecord').classList.toggle('is-active', on);
  $('#btnRecord').textContent = on ? '● Stop recorder' : '● Start recorder';
}

$('#btnRecord').addEventListener('click', () => {
  const on = !state.recording;
  socket.emit('recorder:start', { on });
  setRecording(on);
  if (on) state.events = [];
  renderRecorder();
});

$('#btnDrain').addEventListener('click', () => socket.emit('recorder:drain'));

$('#btnConvert').addEventListener('click', () => {
  if (!state.events.length) return toast('No recorded events', 'err');
  socket.emit('recorder:convert', { events: state.events, targets: state.targets });
  state.events = [];
  renderRecorder();
});

function renderRecorder() {
  const box = $('#recorderList');
  box.innerHTML = '';
  $('#eventCount').textContent = `${state.events.length} event(s)`;
  if (!state.events.length) {
    box.appendChild(h('div', { class: 'empty' }, 'Recorder idle. Tap, scroll and type in the preview, then Convert to steps.'));
    return;
  }
  state.events.slice(-40).forEach((e) =>
    box.appendChild(
      h(
        'div',
        { class: 'item' },
        h('div', { class: 'item-head' }, h('div', { class: 'item-title' }, e.type), h('span', { class: 'badge' }, fmt.time(e.at))),
        h('div', { class: 'badge', style: 'align-self:flex-start;max-width:100%;overflow:hidden;text-overflow:ellipsis' }, e.data ? e.data.selector || e.data.tag || '—' : e.key || `dy ${e.dy ?? ''}`)
      )
    )
  );
}

/* ================================================================== */
/* step + condition builders                                         */
/* ================================================================== */
function stepFields() {
  return (state.meta && state.meta.stepTypes) || [];
}
function conditionTypes() {
  return (state.meta && state.meta.conditionTypes) || [];
}

function fieldControl(label, value, onInput, type = 'text', attrs = {}) {
  return h(
    'label',
    { class: 'field grow', style: 'min-width:104px' },
    label,
    h('input', { type, value: value ?? '', oninput: (e) => onInput(type === 'number' ? Number(e.target.value) : e.target.value), ...attrs })
  );
}

function selectControl(label, value, options, onChange) {
  const sel = h('select', { onchange: (e) => onChange(e.target.value) });
  options.forEach(([v, t]) =>
    sel.appendChild(h('option', { value: v, selected: String(v) === String(value) }, t))
  );
  return h('label', { class: 'field grow', style: 'min-width:140px' }, label, sel);
}

function renderStepsEditor(container, steps, depth = 0) {
  container.innerHTML = '';
  if (!steps.length) {
    container.appendChild(h('div', { class: 'empty' }, 'No steps. Add one from the Action Library.'));
    return;
  }
  steps.forEach((step, i) => {
    const def = stepFields().find((d) => d.type === step.type) || { label: step.type, fields: [] };
    const item = h('div', { class: 'item' });
    item.appendChild(
      h(
        'div',
        { class: 'item-head' },
        h('div', { class: 'item-title' }, `${i + 1}. ${def.label}`),
        h(
          'div',
          { class: 'row', style: 'flex-wrap:nowrap' },
          h('span', { class: 'badge' }, step.type),
          h('button', { class: 'pill tiny icon', title: 'Move up', onclick: () => { if (i > 0) { [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]]; renderSteps(); } } }, '↑'),
          h('button', { class: 'pill tiny icon', title: 'Move down', onclick: () => { if (i < steps.length - 1) { [steps[i + 1], steps[i]] = [steps[i], steps[i + 1]]; renderSteps(); } } }, '↓'),
          h('button', { class: 'pill tiny icon', title: 'Duplicate', onclick: () => { steps.splice(i + 1, 0, JSON.parse(JSON.stringify(step))); renderSteps(); } }, '⧉'),
          h('button', { class: 'pill tiny icon', title: 'Delete', onclick: () => { steps.splice(i, 1); renderSteps(); } }, '✕')
        )
      )
    );

    const rows = [];
    if (step.type === 'click-target') {
      const options = state.targets.map((t) => [t.id, t.name]);
      rows.push(
        options.length
          ? selectControl('Target', step.targetId, [['', '— pick —'], ...options], (v) => (step.targetId = v))
          : h('div', { class: 'badge' }, 'No targets defined yet')
      );
    }
    if (step.type === 'click-point') {
      rows.push(fieldControl('X (viewport px)', step.x ?? 0, (v) => (step.x = v), 'number'));
      rows.push(fieldControl('Y (viewport px)', step.y ?? 0, (v) => (step.y = v), 'number'));
    }
    if (['click-selector', 'type', 'wait-for'].includes(step.type)) {
      rows.push(fieldControl('CSS selector', step.selector ?? '', (v) => (step.selector = v)));
    }
    if (step.type === 'type') rows.push(fieldControl('Text to type', step.text ?? '', (v) => (step.text = v)));
    if (step.type === 'press') rows.push(fieldControl('Key combo', step.key ?? 'Enter', (v) => (step.key = v)));
    if (step.type === 'goto') rows.push(fieldControl('URL', step.url ?? '', (v) => (step.url = v)));
    if (step.type === 'wait') rows.push(fieldControl('Milliseconds', step.ms ?? 1000, (v) => (step.ms = v), 'number'));
    if (step.type === 'wait-random') {
      rows.push(fieldControl('Min ms', step.min ?? 1500, (v) => (step.min = v), 'number'));
      rows.push(fieldControl('Max ms', step.max ?? 4000, (v) => (step.max = v), 'number'));
    }
    if (step.type === 'wait-for') {
      rows.push(selectControl('State', step.state || 'visible', [['visible', 'visible'], ['hidden', 'hidden'], ['attached', 'attached'], ['detached', 'detached']], (v) => (step.state = v)));
      rows.push(fieldControl('Timeout ms', step.timeout ?? 30000, (v) => (step.timeout = v), 'number'));
    }
    if (step.type === 'scroll') {
      rows.push(selectControl('Mode', step.mode || 'by', [['by', 'by pixels'], ['top', 'to top'], ['bottom', 'to bottom']], (v) => (step.mode = v)));
      rows.push(fieldControl('dy pixels', step.dy ?? 600, (v) => (step.dy = v), 'number'));
    }
    if (['cookies', 'storage', 'autofill'].includes(step.type)) {
      rows.push(
        h(
          'label',
          { class: 'field' },
          'JSON payload',
          h('textarea', { oninput: (e) => (step.json = e.target.value) }, step.json || '{}')
        )
      );
    }
    if (step.type === 'js') {
      rows.push(h('label', { class: 'field' }, 'JavaScript (runs in page)', h('textarea', { oninput: (e) => (step.code = e.target.value) }, step.code || '')));
    }
    if (step.type === 'refresh') {
      rows.push(h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!step.hard, onchange: (e) => (step.hard = e.target.checked) }), 'Hard reload (wait for load)'));
    }

    rows.forEach((r) => item.appendChild(h('div', { class: 'row' }, r)));

    if (step.type === 'branch') {
      const thenBox = h('div', { class: 'nested' });
      const elseBox = h('div', { class: 'nested' });
      item.appendChild(
        h('div', { class: 'row' }, renderCondition(step.condition || { type: 'text' }, (c) => (step.condition = c)))
      );
      item.appendChild(h('div', { class: 'nested-label' }, 'THEN'));
      item.appendChild(thenBox);
      item.appendChild(
        h('div', { class: 'row' },
          h('button', { class: 'pill tiny', onclick: () => { step.then = step.then || []; step.then.push({ type: 'click-target' }); renderSteps(); } }, '+ step'),
          h('button', { class: 'pill tiny', onclick: () => { step.else = step.else || []; step.else.push({ type: 'wait', ms: 2000 }); renderSteps(); } }, '+ step')
        )
      );
      item.appendChild(h('div', { class: 'nested-label' }, 'ELSE'));
      item.appendChild(elseBox);
    }

    item.appendChild(
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!step.continueOnError, onchange: (e) => (step.continueOnError = e.target.checked) }), 'Continue on error')
    );

    container.appendChild(item);

    if (step.type === 'branch') {
      step.then = step.then || [];
      step.else = step.else || [];
      const thenHost = item.querySelectorAll('.nested')[0];
      const elseHost = item.querySelectorAll('.nested')[1];
      if (depth < 3) {
        renderStepsEditor(thenHost, step.then, depth + 1);
        renderStepsEditor(elseHost, step.else, depth + 1);
      } else {
        thenHost.appendChild(h('div', { class: 'badge' }, 'max nesting depth'));
      }
    }
  });
}

function renderCondition(cond, onChange, depth = 0) {
  const def = conditionTypes().find((c) => c.type === cond.type) || { label: cond.type, fields: [] };
  const wrapEl = h('div', { class: 'nested' });

  wrapEl.appendChild(
    h(
      'div',
      { class: 'row' },
      selectControl('IF', cond.type, conditionTypes().map((c) => [c.type, c.label]), (v) => { cond.type = v; onChange(cond); })
    )
  );

  if (cond.type === 'text') {
    wrapEl.appendChild(h('div', { class: 'row' }, fieldControl('Selector', cond.selector ?? '', (v) => (cond.selector = v))));
    wrapEl.appendChild(h('div', { class: 'row' },
      selectControl('Operator', cond.op || 'contains', [['contains', 'contains'], ['equals', 'equals'], ['notEquals', 'not equals'], ['startsWith', 'starts with'], ['regex', 'regex']], (v) => (cond.op = v)),
      fieldControl('Value', cond.value ?? '', (v) => (cond.value = v))
    ));
  }
  if (cond.type === 'text-change') {
    wrapEl.appendChild(h('div', { class: 'row' }, fieldControl('Selector', cond.selector ?? '', (v) => (cond.selector = v))));
    wrapEl.appendChild(h('div', { class: 'row' }, fieldControl('New text contains', cond.value ?? '', (v) => (cond.value = v))));
  }
  if (cond.type === 'visible') {
    wrapEl.appendChild(h('div', { class: 'row' }, fieldControl('Selector', cond.selector ?? '', (v) => (cond.selector = v))));
    wrapEl.appendChild(h('div', { class: 'row' },
      selectControl('State', cond.state || 'visible', [['visible', 'appears / visible'], ['hidden', 'hidden'], ['exists', 'exists in DOM'], ['detached', 'removed from DOM']], (v) => (cond.state = v))
    ));
  }
  if (cond.type === 'enabled') {
    wrapEl.appendChild(h('div', { class: 'row' }, fieldControl('Button selector', cond.selector ?? '', (v) => (cond.selector = v))));
    wrapEl.appendChild(h('div', { class: 'row' }, h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!cond.invert, onchange: (e) => (cond.invert = e.target.checked) }), 'Invert (becomes disabled)')));
  }
  if (cond.type === 'url') {
    wrapEl.appendChild(h('div', { class: 'row' },
      selectControl('Operator', cond.op || 'contains', [['contains', 'contains'], ['equals', 'equals']], (v) => (cond.op = v)),
      fieldControl('Value', cond.value ?? '', (v) => (cond.value = v))
    ));
  }
  if (cond.type === 'js') {
    wrapEl.appendChild(h('div', { class: 'row' }, h('label', { class: 'field' }, 'JS expression', h('textarea', { oninput: (e) => (cond.code = e.target.value) }, cond.code || "document.querySelector('#done') !== null"))));
  }
  if (['all', 'any'].includes(cond.type)) {
    cond.conditions = cond.conditions || [{ type: 'text' }];
    cond.conditions.forEach((c, i) => {
      const childHost = h('div', { class: 'nested' });
      childHost.appendChild(renderCondition(c, (nc) => { cond.conditions[i] = nc; onChange(cond); }, depth + 1));
      childHost.appendChild(h('button', { class: 'pill tiny', onclick: () => { cond.conditions.splice(i, 1); onChange(cond); } }, 'Remove'));
      wrapEl.appendChild(childHost);
    });
    if (depth < 2)
      wrapEl.appendChild(h('button', { class: 'pill tiny', onclick: () => { cond.conditions.push({ type: 'visible' }); onChange(cond); } }, '+ condition'));
  }
  if (cond.type === 'not') {
    cond.condition = cond.condition || { type: 'visible' };
    wrapEl.appendChild(renderCondition(cond.condition, (c) => { cond.condition = c; onChange(cond); }, depth + 1));
  }

  return wrapEl;
}

/* ---- action library ---------------------------------------------- */
function renderActionLibrary() {
  const box = $('#actionLibrary');
  box.innerHTML = '';
  stepFields().forEach((def) =>
    box.appendChild(
      h(
        'button',
        {
          class: 'pill tiny',
          onclick: () => {
            const step = { type: def.type };
            if (def.type === 'wait') step.ms = 2000;
            if (def.type === 'wait-random') { step.min = 1500; step.max = 4000; }
            if (def.type === 'scroll') step.dy = 600;
            if (def.type === 'branch') { step.condition = { type: 'visible', selector: '#app' }; step.then = []; step.else = []; }
            state.steps.push(step);
            renderSteps();
          },
          title: def.label,
        },
        def.label
      )
    )
  );
}

function renderSteps() {
  renderStepsEditor($('#stepList'), state.steps);
  $('#stepCount').textContent = `${state.steps.length} step(s)`;
}

/* ================================================================== */
/* rules                                                             */
/* ================================================================== */
$('#btnAddRule').addEventListener('click', () => {
  state.rules.push({
    id: `rule_${Date.now().toString(36)}`,
    name: `Rule ${state.rules.length + 1}`,
    enabled: true,
    cooldownMs: 5000,
    condition: { type: 'text', selector: '#status', op: 'contains', value: 'ready' },
    then: [{ type: 'click-target' }],
    else: [{ type: 'wait', ms: 3000 }],
  });
  renderRules();
});

function renderRules() {
  const box = $('#ruleList');
  box.innerHTML = '';
  $('#ruleCount').textContent = `${state.rules.length} rule(s)`;
  if (!state.rules.length) {
    box.appendChild(h('div', { class: 'empty' }, 'No rules. Add an IF → THEN → ELSE branching rule.'));
    return;
  }
  state.rules.forEach((rule, i) => {
    const item = h('div', { class: 'item' });
    item.appendChild(
      h(
        'div',
        { class: 'item-head' },
        h('div', { class: 'item-title' }, `${i + 1}. ${rule.name}`),
        h(
          'label',
          { class: 'check' },
          h('input', { type: 'checkbox', checked: rule.enabled !== false, onchange: (e) => (rule.enabled = e.target.checked) }),
          'Armed'
        )
      )
    );
    item.appendChild(
      h('div', { class: 'row' },
        fieldControl('Rule name', rule.name, (v) => (rule.name = v)),
        fieldControl('Cooldown ms', rule.cooldownMs ?? 5000, (v) => (rule.cooldownMs = v), 'number')
      )
    );

    const condHost = h('div', {});
    item.appendChild(h('div', { class: 'nested-label' }, 'IF'));
    item.appendChild(condHost);
    condHost.appendChild(renderCondition(rule.condition, (c) => (rule.condition = c)));

    const thenHost = h('div', { class: 'nested' });
    const elseHost = h('div', { class: 'nested' });
    item.appendChild(h('div', { class: 'nested-label' }, 'THEN'));
    item.appendChild(thenHost);
    item.appendChild(h('div', { class: 'nested-label' }, 'ELSE'));
    item.appendChild(elseHost);

    item.appendChild(
      h('div', { class: 'row' },
        h('button', { class: 'pill tiny', onclick: () => { rule.then = rule.then || []; rule.then.push({ type: 'click-target' }); renderRules(); } }, '+ THEN step'),
        h('button', { class: 'pill tiny', onclick: () => { rule.else = rule.else || []; rule.else.push({ type: 'wait', ms: 3000 }); renderRules(); } }, '+ ELSE step'),
        h('button', { class: 'pill tiny', onclick: () => { state.rules.splice(i, 1); renderRules(); } }, 'Delete rule')
      )
    );

    box.appendChild(item);
    rule.then = rule.then || [];
    rule.else = rule.else || [];
    renderStepsEditor(thenHost, rule.then, 2);
    renderStepsEditor(elseHost, rule.else, 2);
  });
}

/* ================================================================== */
/* utilities                                                         */
/* ================================================================== */
$('#btnArmRules').addEventListener('click', () => {
  if (!state.rules.length) return toast('No rules to arm', 'err');
  socket.emit('rules:run', { rules: state.rules, macro: currentMacro() });
});
$('#btnDisarmRules').addEventListener('click', () => socket.emit('rules:stop'));

$('#autoRefreshEnabled').addEventListener('change', (e) => {
  state.autoRefresh.enabled = e.target.checked;
  pushAutoRefresh();
});
$('#autoRefreshInterval').addEventListener('input', (e) => {
  state.autoRefresh.intervalMs = clamp(Number(e.target.value) || 60, 5, 3600) * 1000;
});
$('#autoRefreshHard').addEventListener('change', (e) => {
  state.autoRefresh.hard = e.target.checked;
  pushAutoRefresh();
});
$('#autoRefreshApply').addEventListener('click', pushAutoRefresh);

function pushAutoRefresh() {
  socket.emit('refresh:auto', state.autoRefresh);
  toast(state.autoRefresh.enabled ? `Auto-refresh every ${fmt.ms(state.autoRefresh.intervalMs)}` : 'Auto-refresh off');
}

function renderAutoRefresh() {
  $('#autoRefreshEnabled').checked = !!state.autoRefresh.enabled;
  $('#autoRefreshInterval').value = Math.round((state.autoRefresh.intervalMs || 60000) / 1000);
  $('#autoRefreshHard').checked = !!state.autoRefresh.hard;
  $('#autoRefreshState').textContent = state.autoRefresh.enabled
    ? `RUNNING · tick ${state.autoRefresh.ticks || 0}`
    : 'OFF';
}

$('#humanizeEnabled').addEventListener('change', (e) => (state.humanize.enabled = e.target.checked));
$('#humanizeMin').addEventListener('input', (e) => (state.humanize.minDelay = Number(e.target.value) || 0));
$('#humanizeMax').addEventListener('input', (e) => (state.humanize.maxDelay = Number(e.target.value) || 0));
$('#typingMin').addEventListener('input', (e) => (state.humanize.typingMin = Number(e.target.value) || 0));
$('#typingMax').addEventListener('input', (e) => (state.humanize.typingMax = Number(e.target.value) || 0));

$('#btnRandDelay').addEventListener('click', () => {
  state.steps.push({ type: 'wait-random', min: state.humanize.minDelay, max: state.humanize.maxDelay });
  renderSteps();
  toast('Humanized wait step added');
});

$('#btnAutofill').addEventListener('click', () => {
  socket.emit('quick:step', { step: { type: 'autofill', json: $('#autofillJson').value }, macro: currentMacro() });
});
$('#btnCookies').addEventListener('click', () => {
  socket.emit('quick:step', { step: { type: 'cookies', json: $('#cookieJson').value }, macro: currentMacro() });
});
$('#btnStorage').addEventListener('click', () => {
  socket.emit('quick:step', { step: { type: 'storage', json: $('#storageJson').value }, macro: currentMacro() });
});
$('#btnShot').addEventListener('click', () => {
  socket.emit('quick:step', { step: { type: 'screenshot' }, macro: currentMacro() });
});
$('#btnRefreshNow').addEventListener('click', () => socket.emit('reload'));

$('#btnAddToMacro').addEventListener('click', () => {
  state.steps.push({ type: 'autofill', json: $('#autofillJson').value });
  state.steps.push({ type: 'cookies', json: $('#cookieJson').value });
  state.steps.push({ type: 'storage', json: $('#storageJson').value });
  renderSteps();
  toast('Autofill + cookies + storage appended');
});

/* ================================================================== */
/* run                                                               */
/* ================================================================== */
function currentMacro() {
  return {
    id: state.macroId || undefined,
    name: state.macroName,
    url: state.startUrl,
    viewport: 'phone',
    humanize: { ...state.humanize },
    refresh: { ...state.autoRefresh },
    targets: state.targets,
    steps: state.steps,
    rules: state.rules,
    autofill: {
      data: safeParse($('#autofillJson').value, {}),
      cookies: safeParse($('#cookieJson').value, []),
      localStorage: safeParse($('#storageJson').value, {}),
    },
  };
}

function safeParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return fallback;
  }
}

$('#btnRunOnce').addEventListener('click', () => {
  if (!state.steps.length) return toast('Macro has no steps', 'err');
  socket.emit('engine:run', { macro: currentMacro(), mode: 'once' });
  toast('Run started');
});

$('#btnRunLoop').addEventListener('click', () => {
  if (!state.steps.length) return toast('Macro has no steps', 'err');
  const intervalMs = clamp(Number($('#loopInterval').value) || 30, 5, 3600) * 1000;
  socket.emit('engine:run', { macro: currentMacro(), mode: 'loop', intervalMs });
  toast(`Loop started every ${fmt.ms(intervalMs)}`);
});

$('#btnStopRun').addEventListener('click', () => {
  socket.emit('engine:stop');
  socket.emit('rules:stop');
  toast('Engine stopped');
});

function renderEngineStatus() {
  $('#engineState').textContent = 'READY';
}

/* ---- macro library ----------------------------------------------- */
$('#btnSaveMacro').addEventListener('click', async () => {
  state.macroName = $('#macroName').value || 'Untitled macro';
  state.startUrl = $('#startUrl').value || 'https://example.com';
  const res = await fetch('/api/macros', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(currentMacro()),
  }).then((r) => r.json());
  state.macroId = res.macro.id;
  toast('Macro saved', 'ok');
  loadLibrary();
});

$('#btnNewMacro').addEventListener('click', () => {
  state.macroId = null;
  state.macroName = 'Untitled macro';
  state.targets = [];
  state.steps = [];
  state.rules = [];
  state.events = [];
  $('#macroName').value = state.macroName;
  renderTargets();
  renderSteps();
  renderRules();
  renderRecorder();
  toast('New macro buffer');
});

async function loadLibrary() {
  const data = await fetch('/api/macros').then((r) => r.json()).catch(() => ({ macros: [] }));
  const box = $('#libraryList');
  box.innerHTML = '';
  const macros = data.macros || [];
  $('#libraryCount').textContent = `${macros.length} saved`;
  if (!macros.length) {
    box.appendChild(h('div', { class: 'empty' }, data.degraded ? 'Storage is read-only (mount a volume to persist).' : 'No saved macros yet.'));
    return;
  }
  macros.forEach((m) => {
    const item = h('div', { class: 'item' });
    item.appendChild(
      h('div', { class: 'item-head' },
        h('div', { class: 'item-title' }, m.name),
        h('span', { class: 'badge' }, new Date(m.updatedAt || Date.now()).toLocaleDateString())
      )
    );
    item.appendChild(h('div', { class: 'badge', style: 'align-self:flex-start' }, `${(m.steps || []).length} steps · ${(m.rules || []).length} rules · ${(m.targets || []).length} targets`));
    item.appendChild(
      h('div', { class: 'row' },
        h('button', { class: 'pill tiny', onclick: () => applyMacro(m) }, 'Load'),
        h('button', { class: 'pill tiny', onclick: () => download(m) }, 'Export'),
        h('button', { class: 'pill tiny', onclick: async () => { await fetch(`/api/macros/${m.id}`, { method: 'DELETE' }); loadLibrary(); toast('Deleted'); } }, 'Delete')
      )
    );
    box.appendChild(item);
  });
}

function download(m) {
  const blob = new Blob([JSON.stringify(m, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: `${m.name.replace(/\s+/g, '-').toLowerCase()}.macro.json` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function applyMacro(m) {
  state.macroId = m.id;
  state.macroName = m.name || 'Untitled macro';
  state.startUrl = m.url || 'https://example.com';
  state.targets = m.targets || [];
  state.steps = m.steps || [];
  state.rules = m.rules || [];
  state.humanize = { ...state.humanize, ...(m.humanize || {}) };
  state.autoRefresh = { ...state.autoRefresh, ...(m.refresh || {}) };
  if (m.autofill) {
    if (m.autofill.data) $('#autofillJson').value = JSON.stringify(m.autofill.data, null, 2);
    if (m.autofill.cookies) $('#cookieJson').value = JSON.stringify(m.autofill.cookies, null, 2);
    if (m.autofill.localStorage) $('#storageJson').value = JSON.stringify(m.autofill.localStorage, null, 2);
  }
  $('#macroName').value = state.macroName;
  $('#startUrl').value = state.startUrl;
  $('#address').value = state.startUrl;
  renderTargets();
  renderSteps();
  renderRules();
  renderAutoRefresh();
  toast(`Loaded "${state.macroName}"`, 'ok');
}

$('#btnImportFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    applyMacro(JSON.parse(text));
  } catch (err) {
    toast('Invalid macro file', 'err');
  }
  e.target.value = '';
});

/* ================================================================== */
/* logs + status                                                     */
/* ================================================================== */
function appendLog(entry) {
  const box = $('#log');
  const line = document.createElement('div');
  line.className = entry.level === 'error' ? 'lv-error' : '';
  line.textContent = `${fmt.time(entry.at)}  ${entry.level.toUpperCase().padEnd(5)}  ${entry.message}`;
  box.appendChild(line);
  while (box.childNodes.length > 200) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

function paintFps() {
  const el = $('#statFps');
  if (el) el.textContent = `FPS ~${state.fps || 0}`;
}

function renderStatus() {
  $('#statUrl').textContent = state.url.replace(/^https?:\/\//, '').slice(0, 30) || 'about:blank';
  $('#statSize').textContent = `${state.viewport.width}×${state.viewport.height}`;
  $('#statFps').textContent = `FPS ~${state.fps || 0}`;
  $('#statLive').textContent = '● LIVE';
  $('#statLive').className = 'live';
  if (document.activeElement !== $('#address') && state.url && state.url !== 'about:blank') {
    $('#address').value = state.url;
  }
}

function renderPills() {
  setPicking(state.picking);
  setRecording(state.recording);
}

/* ================================================================== */
/* boot                                                              */
/* ================================================================== */
(async function boot() {
  renderPresets();
  renderAutoRefresh();
  renderRecorder();
  renderRules();
  try {
    state.meta = await fetch('/api/meta').then((r) => r.json());
  } catch (e) {
    state.meta = { stepTypes: [], conditionTypes: [] };
  }
  renderActionLibrary();
  renderSteps();
  renderTargets();
  loadLibrary();
  resizeCanvas();
  setInterval(() => {
    if (socket.connected) socket.emit('ping:state');
  }, 5000);
  setInterval(() => {
    if (state.recording) socket.emit('recorder:drain');
  }, 1500);
})();
