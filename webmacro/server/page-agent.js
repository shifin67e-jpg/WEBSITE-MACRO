/* eslint-disable */
/**
 * page-agent.js — injected into EVERY frame of every page via addInitScript.
 *
 * Responsibilities:
 *   1. Smart Element Picker  -> CSS selector, XPath, id, classes, text, box.
 *   2. Visual Macro Recorder -> taps / clicks / typing / scrolls / key presses.
 *
 * The server flips `__MACRO_AGENT__.picker.on` / `.recorder.on` and drains
 * `.picker.result` / `.recorder.events` with page.evaluate().
 */
(function () {
  if (window.__MACRO_AGENT__ && window.__MACRO_AGENT__.v === 1) return;

  var agent = {
    v: 1,
    picker: { on: false, result: null, done: false, hovering: false },
    recorder: { on: false, events: [], seq: 0, max: 500, lastScroll: 0 },
  };
  window.__MACRO_AGENT__ = agent;
  try {
    Object.defineProperty(window, '__MACRO_AGENT__', { value: agent, configurable: false, writable: false });
  } catch (e) {}

  /* ------------------------------------------------------------------ */
  /* selector helpers                                                    */
  /* ------------------------------------------------------------------ */
  function esc(v) {
    return String(v).replace(/["\\]/g, '\\$&');
  }

  function isUnique(sel) {
    try {
      return document.querySelectorAll(sel).length === 1;
    } catch (e) {
      return false;
    }
  }

  function cssPath(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.id) {
      var byId = '#' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id);
      if (isUnique(byId)) return byId;
    }
    // Prefer stable test hooks
    var hooks = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'name', 'aria-label'];
    for (var h = 0; h < hooks.length; h++) {
      var v = el.getAttribute && el.getAttribute(hooks[h]);
      if (v) {
        var s = '[' + hooks[h] + '="' + esc(v) + '"]';
        if (isUnique(s)) return s;
      }
    }
    var parts = [];
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < 6) {
      var part = node.nodeName.toLowerCase();
      var parent = node.parentNode;
      if (parent && parent.children) {
        var sameTag = [];
        for (var i = 0; i < parent.children.length; i++) {
          if (parent.children[i].nodeName === node.nodeName) sameTag.push(parent.children[i]);
        }
        if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      var candidate = parts.join(' > ');
      if (isUnique(candidate)) return candidate;
      node = parent;
      depth++;
    }
    return parts.join(' > ');
  }

  function xpathOf(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.id) {
      var byId = '//*[@id="' + el.id + '"]';
      try {
        if (document.evaluate(byId, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue === el) {
          return byId;
        }
      } catch (e) {}
    }
    var segs = [];
    var node = el;
    while (node && node.nodeType === 1) {
      var idx = 1;
      var sib = node.previousElementSibling;
      while (sib) {
        if (sib.nodeName === node.nodeName) idx++;
        sib = sib.previousElementSibling;
      }
      segs.unshift(node.nodeName.toLowerCase() + '[' + idx + ']');
      node = node.parentNode;
    }
    return '/' + segs.join('/');
  }

  function textOf(el) {
    if (!el) return '';
    var t = el.innerText || el.textContent || el.value || '';
    return String(t).replace(/\s+/g, ' ').trim().slice(0, 400);
  }

  function describe(el) {
    if (!el || el.nodeType !== 1) {
      el = el && el.parentElement ? el.parentElement : el;
    }
    if (!el || el.nodeType !== 1) return null;
    var rect = { x: 0, y: 0, width: 0, height: 0 };
    try {
      var r = el.getBoundingClientRect();
      rect = { x: r.x, y: r.y, width: r.width, height: r.height };
    } catch (e) {}
    var attrs = {};
    try {
      for (var i = 0; i < el.attributes.length; i++) {
        attrs[el.attributes[i].name] = String(el.attributes[i].value).slice(0, 200);
      }
    } catch (e) {}
    return {
      tag: (el.nodeName || '').toLowerCase(),
      id: el.id || null,
      name: el.getAttribute ? el.getAttribute('name') : null,
      type: el.getAttribute ? el.getAttribute('type') : null,
      role: el.getAttribute ? el.getAttribute('role') : null,
      classes: typeof el.className === 'string' ? el.className : null,
      selector: cssPath(el),
      xpath: xpathOf(el),
      text: textOf(el),
      value: typeof el.value === 'string' ? el.value.slice(0, 300) : null,
      href: el.getAttribute ? el.getAttribute('href') : null,
      placeholder: el.getAttribute ? el.getAttribute('placeholder') : null,
      disabled: !!el.disabled,
      rect: rect,
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
    };
  }

  /* ------------------------------------------------------------------ */
  /* highlight overlay (picker hover + recorder pulse)                   */
  /* ------------------------------------------------------------------ */
  var box = null;
  function ensureBox() {
    if (box && box.isConnected) return box;
    box = document.createElement('div');
    box.setAttribute('data-macro-agent-overlay', '1');
    box.style.cssText =
      'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #ffffff;' +
      'background:rgba(0,0,0,.35);border-radius:4px;transition:all .05s linear;display:none;' +
      'box-shadow:0 0 0 9999px rgba(0,0,0,.12)';
    (document.documentElement || document.body).appendChild(box);
    return box;
  }
  function paintBox(rect, label) {
    if (!rect || rect.width < 0) return;
    var b = ensureBox();
    b.style.display = 'block';
    b.style.left = rect.x + 'px';
    b.style.top = rect.y + 'px';
    b.style.width = rect.width + 'px';
    b.style.height = rect.height + 'px';
    if (label) b.setAttribute('data-label', label);
  }
  function hideBox() {
    if (box) box.style.display = 'none';
  }

  /* ------------------------------------------------------------------ */
  /* picker                                                              */
  /* ------------------------------------------------------------------ */
  function onMove(e) {
    if (!agent.picker.on) return;
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === box) return;
    try {
      paintBox(el.getBoundingClientRect(), '');
    } catch (err) {}
  }

  function blockEvent(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  }

  function handleClickCapture(e) {
    var el = e.target;

    if (agent.picker.on) {
      blockEvent(e);
      var info = describe(el);
      agent.picker.result = info;
      agent.picker.on = false;
      agent.picker.done = true;
      hideBox();
      return;
    }

    if (agent.recorder.on) {
      push('click', describe(el), { button: e.button || 0, x: e.clientX, y: e.clientY });
    }
  }

  /* ------------------------------------------------------------------ */
  /* recorder                                                            */
  /* ------------------------------------------------------------------ */
  function push(type, data, extra) {
    if (!agent.recorder.on) return;
    agent.recorder.seq++;
    var ev = { seq: agent.recorder.seq, type: type, at: Date.now(), data: data || null };
    if (extra) for (var k in extra) ev[k] = extra[k];
    agent.recorder.events.push(ev);
    if (agent.recorder.events.length > agent.recorder.max) agent.recorder.events.shift();
  }

  function onInputCapture(e) {
    if (!agent.recorder.on) return;
    var el = e.target;
    if (!el || !el.tagName) return;
    var tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      push('fill', describe(el), { value: String(el.value || '').slice(0, 500) });
    }
  }

  function onKeyDown(e) {
    if (agent.picker.on) return;
    if (!agent.recorder.on) return;
    if (e.target && /^(input|textarea|select)$/i.test(e.target.tagName || '')) {
      if (e.key && e.key.length === 1) return; // typing is captured as `fill`
    }
    push('key', null, { key: e.key, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey });
  }

  function onScroll(e) {
    if (!agent.recorder.on) return;
    var now = Date.now();
    if (now - agent.recorder.lastScroll < 400) return;
    agent.recorder.lastScroll = now;
    push('scroll', null, { dx: window.scrollX, dy: window.scrollY });
  }

  try {
    document.addEventListener('click', handleClickCapture, true);
    document.addEventListener('mousedown', function (e) {
      if (agent.picker.on) blockEvent(e);
    }, true);
    document.addEventListener('pointerdown', function (e) {
      if (agent.picker.on) blockEvent(e);
    }, true);
    document.addEventListener('submit', function (e) {
      if (agent.picker.on) blockEvent(e);
      else if (agent.recorder.on) push('submit', describe(e.target), null);
    }, true);
    document.addEventListener('input', onInputCapture, true);
    document.addEventListener('change', onInputCapture, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('mousemove', onMove, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('beforeunload', function () {
      if (agent.recorder.on) push('navigate-away', null, { href: location.href });
    });
  } catch (e) {}

  /* ------------------------------------------------------------------ */
  /* helpers used by the server                                          */
  /* ------------------------------------------------------------------ */
  agent.helpers = {
    describe: describe,
    cssPath: cssPath,
    xpathOf: xpathOf,
    textOf: textOf,
    findByText: function (text) {
      var all = document.querySelectorAll('a,button,input,select,textarea,[role=button],span,div,li,td,label');
      for (var i = 0; i < all.length; i++) {
        if (textOf(all[i]) === text) return describe(all[i]);
      }
      return null;
    },
  };

  agent.reset = function () {
    agent.picker.on = false;
    agent.picker.result = null;
    agent.picker.done = false;
    hideBox();
  };
})();
