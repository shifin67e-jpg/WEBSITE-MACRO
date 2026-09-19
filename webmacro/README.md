# WebMacro — Web Automation Macro Platform

Production-ready web-automation platform with a **live Chromium viewer** streamed to an HTML5 canvas
over Socket.io. Headless Playwright drives the browser; the phone-first UI is pure black & white.

Built to run 24/7 on **Railway** (or any container host).

---

## Why the Docker base image matters

The app launches **real Chromium**. A plain `node:*` image ships **no Chromium and none of its
shared libraries** — `chromium.launch()` fails immediately with
`error while loading shared libraries`. The `Dockerfile` therefore starts from the official
Playwright image, which already contains the browser and every system dependency:

```
FROM mcr.microsoft.com/playwright:v1.47.2-jammy
```

`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` is set so the npm install step never re-downloads the browser.

---

## Project structure

```
.
├── Dockerfile                 # Playwright base image (Chromium + all system libs)
├── railway.json               # Dockerfile builder + /healthz healthcheck
├── package.json
├── .env.example
├── .dockerignore
├── server/
│   ├── index.js               # Express + Socket.io host, REST, auto-refresher
│   ├── session.js             # Session & SessionManager: context, page, 10 FPS stream loop, input mapping
│   ├── engine.js              # Macro runner + conditional IF/ELSE rules engine + recorder conversion
│   ├── browser.js             # One shared Chromium instance + container-safe launch flags
│   ├── page-agent.js          # addInitScript: element picker + macro recorder (runs in every frame)
│   ├── store.js               # Best-effort JSON macro library (Railway volume aware)
│   ├── config.js              # Env-driven configuration
│   └── util.js
├── public/
│   ├── index.html             # Two pill-tab workspaces
│   ├── styles.css             # Monochrome design system (#000 / #181818 / #fff / #A1A1AA), pill controls
│   └── app.js                 # Canvas renderer, zoom/fullscreen, crop, builder UIs, socket client
└── tools/
    └── smoke.js               # Headless launch + frame capture verification
```

---

## Feature map

### 1. UI/UX — mobile-first monochrome
- Strict palette: `#000000` canvas, `#181818` cards, `#FFFFFF` accents, `#A1A1AA` secondary text. No colored accents anywhere.
- `max-width: 100vw` + `box-sizing: border-box` everywhere → **zero horizontal scroll**, nothing clips off-screen.
- Every nav bar, tab switcher and action button is a **pill** (`border-radius: 9999px`) with tactile press:
  `:active { transform: translateY(2px) scale(0.98); }`.
- Wide control rows scroll horizontally inside their own strip (still no page-level overflow).

### 2. Workspace separation
| Tab | Purpose |
| --- | --- |
| **Viewer** | Live Chromium canvas, address bar, viewport/zoom/reload, crop + picker activation |
| **Macro**  | Targets, recorder, step builder, rules engine, utilities, macro library |

State is shared across tabs, so "Crop hitbox" in the Macro tab switches to the Viewer for drawing.

### 3. Live Chromium preview engine
- Backend: Playwright headless Chromium → `page.screenshot({ type:'jpeg', quality })` on a throttled loop
  targeting `STREAM_FPS` (default **10 FPS**), emitted as Socket.io **binary** frames with `.volatile()` so slow
  clients drop frames instead of queueing them.
- Front-end paints each frame into `<canvas>` via `createImageBitmap`-style Blob → `Image` → `ctx.drawImage`.
- **Any site**: the address bar feeds `page.goto()` after URL normalization (`example.com` → `https://example.com`).
- Controls: full-screen (`requestFullscreen()`), zoom −/+/reset clamped **50%–300%**, **Force reload**
  (tears the stream down, reloads the page, recreates the page if it died, restarts the loop).
- Input mapping: client canvas coordinates are scaled to server viewport coordinates
  (`sx = viewport.width / canvas.clientWidth`) before `page.mouse.click()` / `page.touchscreen.tap()`,
  with a drag-vs-tap discriminator and a 90 ms-coalesced scroll bridge.

### 4. Macro & conditional engine
- **Crop hitbox selector** — drag on the stream to define `X1,Y1 → X2,Y2`; the box is converted to real viewport
  pixels and gets automatic random click-spot **jitter** (defaults to 20% of the smaller side).
- **Smart element picker** — an injected agent captures CSS selector (id → test-hooks → `:nth-of-type`
  path), absolute XPath, id, classes, inner text, placeholder, and bounding rect.
- **Conditional rules (IF / THEN / ELSE)** — edge-triggered watchers polled at `ENGINE_POLL_MS`:
  - text equals / contains / not-equals / starts-with / regex,
  - text-change to a new value,
  - element appears / visible / hidden / exists / removed,
  - button becomes enabled (or inverts to disabled),
  - URL contains / equals, plus custom JS expressions,
  - composable `ALL (AND)`, `ANY (OR)`, `NOT`.
  A rule fires **only when its truth flips** (with an optional cooldown), then runs the `then` or `else`
  step list. Inline `branch` steps give nested IF/ELSE inside any sequence (depth-capped at 6).
- **Action library** — click target/point/selector, type, press key, navigate, wait, humanized wait,
  wait-for-element, scroll, refresh (soft/hard), cookie injection, localStorage injection, JSON form autofill,
  screenshot, raw JS, and branch.
- **Auto-site refresher** — configurable interval with random jitter and a hard-reload switch.
- **Recorder** — toggles live capture of taps, typing, key combos and scrolls; **Convert to steps** turns
  the event stream into editable steps, creating reusable pinned targets from every recorded element and
  inserting `wait-random` steps between actions.
- **Humanization** — randomized sleep between 1.5 s and 4 s, plus per-character typing delays (60–190 ms).

---

## Local run

```bash
npm install
npx playwright install chromium      # only needed outside the Docker image
npm start                            # → http://localhost:3000
npm run smoke                        # headless launch + frame byte check
```

## Deploy to Railway

1. Push this folder to a Git repo.
2. Railway → **New Project → Deploy from GitHub repo**. `railway.json` selects the Dockerfile builder.
3. **Do not** override the start command; the server binds `0.0.0.0:$PORT` (Railway injects `PORT`).
4. Set the healthcheck path to `/healthz` (already declared in `railway.json`).
5. Optional: attach a **Volume** and set `DATA_DIR=/data` so the macro library survives redeploys.
6. Optional env vars: `STREAM_FPS`, `STREAM_QUALITY`, `MAX_SESSIONS`, `DEFAULT_VIEWPORT`.

### Container sizing notes
Chromium is memory-hungry: budget **~400–600 MB** per simultaneous session. `MAX_SESSIONS` (default 4)
caps concurrency, and idle sessions are reaped after `SESSION_IDLE_MS` (default 15 min).
`--disable-dev-shm-usage` is set so the browser does not exhaust the container's small `/dev/shm`.

---

## REST surface

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/healthz` | Uptime, browser status, session count, storage state |
| `GET` | `/api/meta` | Step catalogue, condition catalogue, viewport presets, limits |
| `GET` | `/api/macros` | Saved macro library |
| `POST` | `/api/macros` | Create / update a macro |
| `DELETE` | `/api/macros/:id` | Delete a macro |
| `POST` | `/api/macros/import` | Replace the library from a JSON export |

## Socket.io surface (highlights)

`session:create` · `session:attach` · `nav` · `reload` · `viewport:set` · `stream:opts` · `input`
· `picker:start` → `picker:result` · `recorder:start` / `recorder:drain` / `recorder:convert`
· `engine:run` / `engine:stop` · `rules:run` / `rules:stop` · `refresh:auto` · `quick:step`

---

## Legal notice

This tool automates a real browser. You are responsible for complying with the terms of service of any
site you automate, and with applicable laws (including anti-bot and data-protection rules). Use it only
on systems you own or are authorized to operate.
