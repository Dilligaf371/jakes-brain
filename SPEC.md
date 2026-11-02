# Jake's Brain — personal iPhone app, backend on the Linux PC

Jake's Brain is Jake's personal iPhone app. It is a thin native shell (SwiftUI + WKWebView)
around a web app + JSON API that run on his Linux PC. Editing `web/` or `server/`
on the PC changes the app with no rebuild; only `ios/` changes need Xcode.

## Hosts and addresses (facts, do not invent others)

| thing | value |
|---|---|
| PC hostname | jacob-beauchamp-MS-7C02 (Ubuntu, kernel 7.0) |
| PC Tailscale IP | 100.106.249.89 |
| PC LAN IP | 192.168.1.81 |
| PC ssh alias (from the Mac) | `pcserver` (user jacob-beauchamp) |
| PC node | /home/jacob-beauchamp/.nvm/versions/node/v22.23.3/bin/node (v22.23.3) |
| PC repo path | /home/jacob-beauchamp/jakes-data-app |
| PC data dir | /home/jacob-beauchamp/jakes-data-app-data (SQLite lives here, NOT in the repo) |
| Server port | 4800 |
| Mac repo path | /Users/jacobbeauchamp/jakes-data-app |
| iOS bundle id | com.jakebeau.jakesdata |
| Apple team | 3VTHP9BHH6 (paid, Individual) |
| Jake's iPhone UDID | 00008150-00062DD41408401C (iPhone 17 Pro) |

Base URLs the phone tries, in order: `http://100.106.249.89:4800` (Tailscale, works
anywhere once Tailscale is on the phone) then `http://192.168.1.81:4800` (home WiFi).

## Repo layout

```
jakes-data-app/
  SPEC.md            this file (the contract)
  README.md          human docs: what it is, how to update, how to install on the phone
  CLAUDE.md          agent-facing rules (AGENTS.md is the same file for Codex)
  server/            Node 22, ZERO npm dependencies (node:http, node:sqlite, node:fs, node:child_process)
    index.js         entry: static files from ../web, /media + /cache, core /api routes, loads apps/*.js
    db.js            node:sqlite (DatabaseSync) open + migrations registry + settings
    router.js        register(method, pattern, handler), ':param' segments, 404/405 JSON
    http.js          sendJson/sendError, body readers, sendFile with Range support, CORS allow-list
    tools.js         ffmpeg/ffprobe resolution, execFile wrapper, concurrency-1 queue, fetchJson
    status.js        machine + service status collection
    config.json      services, tools, file roots, video channels, gpt, weather (see below)
    apps/<id>.js     one server module per app (see "Server (server/) — core contract")
  web/               plain HTML/CSS/JS, NO build step, mobile-first (390px), dark+light
    index.html  kit.js  launcher.js  styles.css  apps.json  manifest.webmanifest  icons/
    apps/<id>/       index.js + styles.css per app (see "Web (web/) — core contract")
  ios/               xcodegen project (project.yml) -> JakesData.xcodeproj (generated, gitignored)
    Jake's Brain/              Swift sources + Assets.xcassets + Info.plist
  deploy/
    jakes-data.service       systemd --user unit for the PC
    deploy.sh        Mac -> PC: commit + git push to the PC, hook restarts the service
    install-on-phone.sh   xcodegen + xcodebuild + devicectl install onto Jake's iPhone
    run-sim.sh       build + run in the booted simulator
```


## v2: a home screen inside the app

Jake's Brain v2 is a **launcher**: the first screen is an iPhone-style home screen (a grid of
app tiles + a dock). Tapping a tile opens one of Jake's own apps full-screen. Every app is a
small ES module under `web/apps/<id>/` plus (if it needs data) a server module
`server/apps/<id>.js`. Nothing native changes; the shell is a WKWebView with inline media
playback and photo/camera pickers enabled.

### The apps (ids are fixed — `web/apps.json` is written already, do not edit it)

| id | label | tile colour | what it is |
|---|---|---|---|
| `notes` | Notes | #ffcc00 | real notes: title + body, autosave, search, pin |
| `tasks` | Tasks | #5e5ce6 | the v1 checklist (the old `notes` table, renamed `tasks`); badge = open count |
| `calendar` | Calendar | white tile, red day number (like iOS) | month grid + day agenda + events |
| `jakestagram` | Jakestagram | #e1306c | private Instagram: post photos/videos from the phone, feed + grid profile, hearts |
| `jaketube` | JakeTube | #e62117 | private YouTube over the PC's videos (daily auto-vlogs, raw Pocket 3, game captures) |
| `jakegpt` | JakeGPT | #10a37f | private ChatGPT on the PC's Ollama (streaming), conversations saved |
| `habits` | Habits | #ff9f0a | daily habits, streaks, 7-day strip |
| `files` | Files | #0a84ff | read-only browser of PC folders with image/video/text preview |
| `weather` | Weather | #32ade6 | Open-Meteo forecast for a city set in Weather/Settings |
| `server` | Server | #34c759 | the v1 Home screen: PC stats + one row per service |
| `settings` | Settings | #8e8e93 | the v1 About screen + per-app settings (weather city, JakeGPT model) |

Dock (bottom, always visible on the home screen): `notes`, `jakestagram`, `jaketube`, `jakegpt`.
Grid order: `calendar`, `tasks`, `habits`, `weather`, `files`, `server`, `settings`.

## Web (web/) — core contract

```
web/
  index.html        shell: #home (launcher), #app (active app layer), #banner (offline), #toast, #sheet
  styles.css        core: launcher, nav bar, shared components, light+dark, safe areas
  kit.js            shared helpers (below) — every app imports from '../../kit.js'
  launcher.js       home screen, hash router, app lifecycle, badges, build-change reload
  apps.json         registry (fixed)
  icons/app-<id>.svg   tile glyphs: 64x64 viewBox, white strokes/fills on transparent, 2px-ish strokes,
                    simple geometric shapes (think SF Symbols), NO gradients, NO emoji, NO clip-art
  apps/<id>/index.js   export default { mount(root, ctx), unmount(), route(sub) }   (route optional)
  apps/<id>/styles.css every selector prefixed with `.app-<id> ` (the launcher adds that class to root)
```

- **No framework, no bundler.** ES modules, `import` relative paths. Each app's `index.js` is
  loaded with `import('./apps/<id>/index.js')` the first time it opens; its `styles.css` is
  injected once as a `<link>`.
- **Routing:** `location.hash` is the source of truth. `#/` = home. `#/<id>` opens an app;
  `#/<id>/<sub...>` is passed to the app as `sub` (`"42"`, `"2026-11"`, `"watch/abc"`). On a hash
  change inside the same app the launcher calls `app.route(sub)` if defined, otherwise
  unmount + mount. Browser back works (history). `ctx.nav.go('#/notes/42')`, `ctx.nav.back()`
  (history.back() if the previous entry was inside the same app, else home), `ctx.nav.home()`.
- **Launcher look (iPhone-like, calm):** plain background (light #f2f2f7 / dark #000, same as
  v1), a small date line at the top ("Sunday, November 2"), a 4-column grid of 60×60 tiles with
  14px corner radius and 11px labels, a dock (4 tiles, rounded 24px bar, slightly tinted
  background) pinned to the bottom above the safe area. Tile = solid colour + the SVG glyph
  (white) at 56% size, except `calendar` which draws the current weekday (red, small caps) and
  day number (large, black/white) on a white (dark: #1c1c1e) tile. Tap → the #app layer scales
  in from the tile (transform-origin at the tile centre, 220 ms) and the home dims; back → reverse.
  Badges: an entry in apps.json may have `"badge": "/api/tasks/badge"`; the launcher fetches it
  when the home screen is shown and draws a red count badge (hidden when 0).
- **App nav bar** (via `kit.navbar`): fixed at top with safe-area padding; left = `‹ Home`
  (or `‹ Back` when the app is deeper than its root — the app passes `back: true`), centre
  title, right = optional action buttons. Content scrolls under it; apps pad their content with
  `var(--nav-h)` (the kit sets it).
- **Build-change reload** (from v1) stays: poll `/api/version` every 30 s and on
  `jakesdata:foreground`; reload when `build` changes, but NOT while `kit.holdReload(key)` is
  held (typing in a field, an upload in flight, a video playing, a chat streaming). Apps must
  hold/release around those.
- **Offline banner + backoff** (from v1) stays and is global.
- **Native bridge** (from v1): `window.JakesData = { native, version }` and
  `window.webkit?.messageHandlers?.native?.postMessage({type:'haptic', style})` — only via
  `kit.haptic()`.
- **Confirm dialogs:** never `window.confirm`/`alert`/`prompt` (the shell has no WKUIDelegate —
  they silently return false). Use `kit.confirmSheet(...)`.
- Design rules: system font stack, light + dark via `prefers-color-scheme`, solid colours only,
  no gradients, no emoji as icons, no decorative illustration, 44px tap targets, inputs ≥ 16px
  font (no zoom), `env(safe-area-inset-*)` everywhere it matters. Jake rejects AI-looking UI.

### kit.js (the core builder writes this; apps rely on exactly these names)

```js
export async function api(path, { method='GET', body, timeout=8000, headers={}, raw=false } = {})
  // JSON in/out, relative /api paths, AbortController timeout, throws ApiError { status, message }
  // raw=true returns the Response (for streams)
export function upload(path, file, { onProgress, headers={}, timeout=180000 } = {})
  // XHR PUT of the raw file body (Content-Type = file.type, X-Filename header), resolves JSON; onProgress(0..1)
export function el(tag, attrs = {}, ...children)   // attrs: class, text, html(escaped already), on:click, dataset..., style object
export function esc(str)
export const fmt = { relTime(iso), date(iso|Date, {weekday,month,day,year,time}), time(iso), duration(seconds), bytes(n), dayKey(Date) /* 'YYYY-MM-DD' local */ }
export function toast(message, { kind='info'|'error', ms=2200 } = {})
export function haptic(style)                           // 'light'|'medium'|'success'|'error'
export function confirmSheet({ title, message, confirmLabel='OK', destructive=false }) // Promise<boolean>, bottom sheet
export function navbar({ title, back=false, right=[] /* array of elements */, onBack }) // returns element; the app puts it first in root
export function section(title)                          // small caps header like v1 "SERVICES"
export function emptyState(text)
export function holdReload(key) / releaseReload(key)
export const store = { get(key, fallback), set(key, value), del(key) }   // localStorage JSON, try/catch
export function debounce(fn, ms)
export function renderMarkdownLite(text) // escapes, then **bold**, `code`, ```blocks```, - lists, paragraphs → HTML string
```

`ctx` passed to `mount(root, ctx)`: `{ id, sub, nav: {go, back, home}, kit }` (kit = the whole
module, so apps can also just import it). `root` is an empty `<div class="app-<id>">` already
inside `#app`. `unmount()` must clear timers/listeners/holds.

## Server (server/) — core contract

```
server/
  index.js      http server; static web/; /media/*; router; loads server/apps/*.js; SIGTERM
  db.js         DatabaseSync (WAL, busy_timeout 250) + migrations registry; applies CORE migrations
                first, then each module's migrations in module-id alphabetical order; table
                `migrations(id TEXT PRIMARY KEY, applied_at)`; ids are strings like 'core-2', 'notes-1'
  router.js     register(method, pattern, handler); ':param' segments; query parsing; 404/405 JSON
  http.js       sendJson(res, status, obj), sendError(res, status, msg), readJsonBody(req, {limit=65536}),
                readRawBody(req, {limit}), sendFile(req, res, absPath, {cacheControl, download}) with
                HTTP Range support (206, Accept-Ranges, Content-Range, HEAD), cors(res)
  tools.js      resolve ffmpeg/ffprobe: env JAKESDATA_FFMPEG / JAKESDATA_FFPROBE, else config.tools, else
                PATH, else null; run(cmd, args, {timeout, maxBuffer}) → {stdout, stderr, code};
                fetchJson(url, {timeout}) via global fetch (Node 22)
  status.js     v1 machine status (unchanged)
  config.json   see below; env JAKESDATA_CONFIG overrides the path (tests use a scratch copy)
  apps/<id>.js  export default { id, migrations: [{ id, sql }], register(r, ctx) }
                ctx = { db, cfg, dataDir, mediaDir(appId) /* DATA/media/<id>, created */, cacheDir, tools, log, homeDir }
```

- Still **zero npm dependencies**, Node 22 only (`node:http`, `node:sqlite`, `node:fs`,
  `node:path`, `node:os`, `node:child_process`, global `fetch`).
- Env: `JAKESDATA_PORT` 4800, `JAKESDATA_DATA` `$HOME/jakes-data-app-data`, `JAKESDATA_WEB`,
  `JAKESDATA_BIND`, `JAKESDATA_CONFIG`, `JAKESDATA_OLLAMA` (default `http://127.0.0.1:11434`),
  `JAKESDATA_FFMPEG`, `JAKESDATA_FFPROBE`.
- Data layout: `DATA/jakesdata.db`, `DATA/media/<app>/…` (uploads), `DATA/cache/<app>/…`
  (regenerable: thumbnails). `GET /media/<app>/<file>` serves `DATA/media/<app>/<file>` with
  Range support; `GET /cache/<app>/<file>` likewise. Both reject traversal (realpath must stay
  inside), hide dotfiles.
- Core routes (unchanged shapes from v1): `GET /api/health` (name "jakes-data"),
  `GET /api/version`, `GET /api/status`. New core: `GET /api/settings` → `{ settings: {k: v} }`,
  `PATCH /api/settings` body `{k: v, ...}` (values are JSON, strings/numbers/booleans/null;
  null deletes) — table `settings(key TEXT PRIMARY KEY, value TEXT, updated_at)`.
  Core migration `core-2`: `ALTER TABLE notes RENAME TO tasks` (only if `notes` exists and
  `tasks` does not), so the v1 checklist data survives under the Tasks app.
- Static rules from v1 stay (no-store for html/js/css/json/webmanifest/svg, max-age for png/jpg,
  SPA fallback only for paths without a file extension, traversal/symlink rejection).
- Errors: `{ "error": "message" }`; never crash on a bad request; log `METHOD path status ms`.
- Shelling out: always `execFile` with an args array (never a shell string), timeouts, and a
  concurrency cap of 1 for ffmpeg jobs (a tiny in-process queue in tools.js: `tools.queue(fn)`).

### config.json (core builder writes this; app builders READ it and may rely on these keys)

```json
{
  "services": [ ...v1 list unchanged, with "jakes-data.service" labelled "Jake's Brain (this app)" ],
  "tools": { "ffmpeg": "/home/jacob-beauchamp/pocket3-vlog/bin/ffmpeg", "ffprobe": "/home/jacob-beauchamp/pocket3-vlog/bin/ffprobe" },
  "fileRoots": [
    { "name": "Videos",     "path": "~/Videos" },
    { "name": "Pictures",   "path": "~/Pictures" },
    { "name": "Downloads",  "path": "~/Downloads" },
    { "name": "Boost data", "path": "~/boost_data" }
  ],
  "videoChannels": [
    { "id": "vlogs", "name": "Daily Vlogs",   "paths": ["~/Videos/pocket3-vlog/vlogs"], "recursive": false },
    { "id": "raw",   "name": "Pocket 3 raw",  "paths": ["~/Videos/pocket3-vlog"],       "recursive": false },
    { "id": "games", "name": "Game captures", "paths": ["~/Videos/Fortnite", "~/Videos/Call of Duty  Modern Warfare 2019", "~/Videos/Captures"], "recursive": true },
    { "id": "boost", "name": "Boost",         "paths": ["~/Videos/boost"], "recursive": true }
  ],
  "gpt": { "defaultModel": "qwen3.5:9b", "system": "You are JakeGPT, Jake's private assistant running on his own PC. Be direct and concise." },
  "weather": { "units": "fahrenheit" }
}
```
`~` expands to the server user's home. Missing folders are skipped silently (on the Mac none
of them exist). Note `~/Videos/pocket3-vlog/vlogs` holds symlinks (`2026-10-14.mp4 → …/.work/vlog-2026-10-14.mp4`,
plus `latest.mp4` pointing at the newest): follow symlinks, dedupe by realpath, and drop the
`latest.mp4` alias.

## App contracts

Every app: its own `web/apps/<id>/index.js` + `styles.css`, and `server/apps/<id>.js` if it
has data. Routes are all under `/api/<id>/…`. Tables are prefixed with the app id unless noted.
Timestamps ISO strings. Lists newest-first unless noted. Every list endpoint is fast (< 200 ms
without media work). All inputs validated (400), missing rows 404.

### notes
- Table `notes(id, title TEXT, body TEXT, pinned INTEGER 0/1, created_at, updated_at)` (migration `notes-1`; it runs after core-2, so the name is free).
- `GET /api/notes?q=` (q searches title+body, LIKE), `POST /api/notes {title?, body?}` → 201,
  `GET /api/notes/:id`, `PATCH /api/notes/:id {title?, body?, pinned?}`, `DELETE /api/notes/:id` → 204.
- UI: list (pinned first, then updated desc) with title (or "Untitled"), first line preview,
  relative time; search field; `+` creates and opens the editor; editor = title input + body
  textarea (auto-growing), autosave debounced 600 ms with a tiny "Saved · 2s ago" line, pin and
  delete in the nav bar right slot (delete via confirmSheet). Sub-route `#/notes/<id>`.
  holdReload while the editor has focus.

### tasks
- Table `tasks` = the renamed v1 table (id, text, done, created_at, updated_at). Migration id
  `tasks-1` may be a no-op or add an index.
- `GET /api/tasks`, `POST /api/tasks {text}`, `PATCH /api/tasks/:id {text?, done?}`,
  `DELETE /api/tasks/:id`, `GET /api/tasks/badge` → `{ count: <open> }`.
- UI = the v1 Notes tab moved here unchanged in behaviour (input + Add, Open / Done sections,
  two-tap delete), title "Tasks".

### calendar
- Table `calendar_events(id, title, date TEXT 'YYYY-MM-DD', start_time TEXT 'HH:MM' | NULL, end_time TEXT | NULL, all_day INTEGER, notes TEXT, created_at, updated_at)`.
- `GET /api/calendar/events?from=YYYY-MM-DD&to=YYYY-MM-DD` (inclusive, max 62 days),
  `POST`, `PATCH /:id`, `DELETE /:id`.
- UI: month header with ‹ › and a "Today" button; 7-column grid (Sunday first) with the
  selected day highlighted, today ringed, a small dot under days with events; below the grid a
  list of the selected day's events (all-day first, then by start time) with time + title; tap
  → edit sheet; `+` → add sheet (title, date default selected day, all-day toggle, start/end
  `<input type=time>`, notes). Sub-route `#/calendar/YYYY-MM` keeps the month on reload.
  Swipe left/right on the grid changes month (touch events, 50px threshold).

### jakestagram
- Table `gram_posts(id, kind 'image'|'video', file TEXT, thumb TEXT|NULL, width, height, caption TEXT, liked INTEGER, created_at)`.
- `PUT /api/jakestagram/upload` raw body (≤ 300 MB; Content-Type image/* or video/*,
  header `X-Filename`), saves to `DATA/media/jakestagram/<id>.<ext>`; makes a thumb via ffmpeg
  (image → 720px-wide JPEG `<id>_t.jpg`; video → poster frame at 1 s) when ffmpeg exists,
  else `thumb = null` (client falls back to the original); reads dimensions with ffprobe when
  available. → `201 { upload: { file, thumb, kind, width, height } }`.
- `POST /api/jakestagram/posts { file, thumb, kind, width, height, caption }` → 201,
  `GET /api/jakestagram/posts?before=<id>&limit=20`, `PATCH /:id { caption?, liked? }`,
  `DELETE /:id` → 204 and removes the files.
- UI: two segments in the nav bar: **Feed** and **Profile**. Feed: cards = media (image via
  `/media/jakestagram/<thumb or file>`, video via `<video playsinline controls poster>`),
  heart toggle (filled red when liked) + relative time, caption below; infinite scroll by
  `before`. Profile: 3-column square grid of thumbs; tap → feed scrolled to that post
  (`#/jakestagram/p/<id>`). `+` in the nav bar → compose: `<input type=file accept="image/*,video/*">`
  (iOS shows the library/camera picker), preview, caption field, Post button with a progress
  bar (kit.upload onProgress); holdReload during upload. Delete via confirmSheet in a post's
  `…` menu (a small sheet with Delete / Copy caption? keep: Delete only).

### jaketube
- Table `tube_videos(id TEXT PRIMARY KEY /* sha1(realpath) first 16 */, channel, path /* realpath */, name, size, mtime, duration REAL|NULL, width, height, thumb TEXT|NULL, probed_at)`,
  `tube_progress(video_id PRIMARY KEY, seconds REAL, duration REAL, updated_at)`.
- Scan: `GET /api/jaketube/videos?channel=&q=` lists videos (newest mtime first) from a scan of
  `cfg.videoChannels` (extensions mp4 mov m4v mkv webm; cache the directory scan 60 s; upsert
  rows; rows whose file vanished are dropped). Probing (duration/dims via ffprobe) and thumbs
  (ffmpeg frame at min(10 % of duration, 30 s), 480px wide JPEG into `DATA/cache/jaketube/<id>.jpg`)
  happen lazily in the background queue after a list call; the list returns `thumb: null`
  until ready, and the client re-fetches the list once after 4 s if any thumb was null.
  `GET /api/jaketube/videos/:id`, `GET /api/jaketube/stream/:id` → the file with Range support
  (this is what `<video src>` uses), `GET /api/jaketube/channels` → `[{id,name,count}]`,
  `GET/PUT /api/jaketube/progress/:id` ({seconds, duration}).
- UI: home = channel chips (All + each channel) + search + a list of cards (16:9 thumb with a
  duration pill, title = the file name made readable: `2026-10-15.mp4` → "Oct 15, 2026",
  `2026-10-15_19-07-48.mp4` → "Oct 15, 2026 · 7:07 PM", other names → stem; subtitle = channel ·
  size; a thin red progress bar on the thumb when partly watched). Watch page
  (`#/jaketube/watch/<id>`): `<video controls playsinline autoplay>` 16:9 at the top, title,
  meta, "Resume from 12:34" if progress exists (seek on loadedmetadata), save progress every
  5 s and on pause/unmount, then an "Up next" list (same channel). holdReload while playing.
  Note in the About/Settings of JakeTube (one line): 4K files stream as-is, so over Tailscale
  they may buffer; LAN is fine.

### jakegpt
- Tables `gpt_conversations(id, title, model, created_at, updated_at)`, `gpt_messages(id, conversation_id, role 'user'|'assistant'|'system', content, created_at)`.
- `GET /api/jakegpt/models` → `{ models: [{name, size}] , default }` from Ollama `/api/tags`
  (503 `{error:"Ollama is not running"}` when unreachable). `GET /api/jakegpt/conversations`,
  `POST` {model?} → 201, `GET /:id` (with messages), `DELETE /:id`, `PATCH /:id {title}`.
  `POST /api/jakegpt/conversations/:id/messages { content }` → saves the user message, calls
  Ollama `POST /api/chat` with `stream: true` (system prompt from cfg.gpt.system + full history),
  and streams back `application/x-ndjson`, one JSON object per line: `{ "delta": "text" }` …
  `{ "done": true, "message_id": n }`; saves the assistant message when done (or what was
  received if the client aborts — handle `req` 'close'). Auto-title the conversation from the
  first user message (first 40 chars) if untitled. Timeouts: 120 s idle.
- UI: conversation list (title, model, relative time; swipe-free: `…` → Delete via sheet);
  `+` new chat; chat view: bubbles (user right/tinted, assistant left/plain, assistant content
  through `kit.renderMarkdownLite`), a streaming cursor, composer pinned to the bottom above the
  keyboard (textarea auto-grow, Send button, Stop while streaming → aborts the fetch), model
  picker in the nav bar right slot (a sheet listing models; default from `/api/settings`
  `gpt.model` else cfg default). First token can take ~10 s while the model loads: show
  "Loading model…" after 2 s with no delta. holdReload while streaming.

### habits
- Tables `habits(id, name, color TEXT, created_at, archived INTEGER)`, `habit_checks(habit_id, date 'YYYY-MM-DD', PRIMARY KEY(habit_id, date))`.
- `GET /api/habits?days=7` → habits with `checks: ['2026-11-01', …]` for the window and
  `streak` (consecutive days ending today or yesterday), `POST {name, color}`, `PATCH /:id`,
  `DELETE /:id`, `PUT /api/habits/:id/checks/:date` (toggle on) / `DELETE …/:date` (off).
- UI: one row per habit: colour dot, name, streak ("12 days"), and a 7-day strip of small
  circles (today rightmost, tap today to toggle; past days read-only... allow toggling
  yesterday too). `+` → sheet with name + 6 colour swatches. Archive/delete via `…` sheet.

### files
- No tables. `GET /api/files/list?root=<name>&path=<relative>` → `{ root, path, entries: [{name, kind 'dir'|'file', size, mtime, ext}] }` (dirs first, alphabetical, dotfiles hidden),
  `GET /api/files/roots` → `[{name, exists}]`, `GET /api/files/get?root=&path=` → the file with
  Range support (inline), `GET /api/files/text?root=&path=` → first 200 KB as `{ text, truncated }`
  for text-ish extensions. Containment: resolve `realpath(root)` and `realpath(root/path)`;
  the latter must start with the former + sep; 400 otherwise; 404 if missing.
- UI: roots list → folder view with a breadcrumb in the nav bar title and `‹ Back` going up
  one level (`#/files/<root>/<path>`); rows with a folder/file glyph, name, size or item count;
  previews: image (full width), video (`<video controls playsinline>`), text/md/json/log/csv
  (monospace, scrollable), otherwise name + size + "No preview".

### weather
- Settings keys: `weather.city` (string), `weather.lat`, `weather.lon`, `weather.units`.
- `GET /api/weather/search?q=` → Open-Meteo geocoding top 5 `[{name, admin1, country, lat, lon}]`;
  `GET /api/weather?lat=&lon=&units=` → proxied Open-Meteo forecast trimmed to
  `{ current: {temp, feels, code, wind, humidity, time}, hourly: [{time, temp, code, precip}] (next 24 h), daily: [{date, min, max, code, precip}] (7 d) }`,
  cached 10 min per lat/lon. Weather codes → short labels + a small set of inline SVG glyphs
  (sun, cloud, rain, snow, storm, fog) drawn by the app — simple strokes, no emoji.
- UI: if no city set → a search field with results to pick; else: city + current temp (large),
  condition, feels like, wind; an hourly strip (horizontal scroll); a 7-day list with min/max
  bars. Nav right: "Change" (search again). Units toggle °F/°C writes `weather.units`.
- Family (added 2026-11-02): under the hero, a "Family" card with one row per person in the
  app's `FAMILY` list (Mom & Dad — Chicago, JM — Richmond VA, T — Seattle): name, city, local
  time, glyph, current temp, today's high/low. A row opens `#/weather/family/<id>` (that city's
  full forecast). `/api/weather` also returns `utcOffset` (seconds) for the local time.


### graph  (added 2026-11-02 — "an Obsidian-like graph of all my data")
- Tile: id `graph`, label "Graph", colour #bf5af2, glyph = three dots joined by lines. The graph
  builder also writes `web/icons/app-graph.svg`.
- `GET /api/graph` → `{ nodes: [...], edges: [...], generated_at }`, cached 30 s. Built READ-ONLY
  from the other apps' tables (they are all defined in this SPEC; tolerate a missing table —
  an app not built yet — by skipping it):
  - item nodes: `note` (notes: label = title or first line), `task` (tasks: text, done),
    `event` (calendar_events: title, date), `post` (gram_posts: caption or "Photo"/"Video",
    thumb), `video` (tube_videos: readable name per the JakeTube rule, channel), `chat`
    (gpt_conversations: title), `habit` (habits: name). Node shape:
    `{ id: '<type>:<rowid>', type, label, app: '<app id>', route: '#/notes/42', date: 'YYYY-MM-DD'|null, meta: {...small} }`.
  - hub nodes: `day` (`id: 'day:2026-11-02'`, label "Nov 2", route `#/calendar/2026-11`) for every
    date that has ≥ 1 item; `tag` (`id: 'tag:focus'`, label "#focus") for every `#tag` found in
    note title/body, task text, event title/notes, post caption, chat title.
  - edges `{ source, target, kind }`: `day` item↔day (notes/tasks/posts/chats by created_at local
    date, events by date, videos by mtime date, habits ↔ each day they were checked in the last
    60 days); `tag` item↔tag; `link` note→note for `[[Title]]` (case-insensitive match on note
    title); `app`-less (no app hub nodes — colour carries the app).
  - Caps: at most 2000 nodes; if exceeded drop the oldest day clusters first and set
    `truncated: true`.
- UI (`web/apps/graph/`): a full-bleed `<canvas>` under the nav bar, Obsidian-like: dark canvas
  (#161616) in dark mode, #f2f2f7 in light; nodes = filled circles sized by degree (4–14 px),
  coloured by app (tile colours from `web/apps.json`; day = #8e8e93, tag = #64d2ff); edges thin
  low-alpha lines. Own force simulation (no library, no CDN): repulsion (grid-bucketed
  approximation is fine), spring edges, centre gravity, cooling; ~300 ticks then idle; re-heat
  on drag. Interactions: drag empty space = pan, pinch / wheel = zoom (0.2–4), drag a node,
  tap/click a node = select: highlight its neighbours (dim the rest), show a bottom card (label,
  type, date, app) with an **Open** button → `ctx.nav.go(node.route)`. Labels: shown for
  selected + neighbours always, and for all nodes when zoom ≥ 1.6 (day/tag labels at ≥ 1.0).
  Nav bar right: a filter button → sheet with type toggles (notes, tasks, events, posts,
  videos, chats, habits, days, tags; persisted in kit.store `graph.filters`) and a search field
  that highlights matching labels. Sub-route `#/graph/<nodeId>` selects and centres that node.
  Devices: must stay smooth on an iPhone with ~800 nodes (cap simulation work per frame,
  use devicePixelRatio, `touch-action: none` on the canvas, no scrolling of the page).
  Must also work with a mouse at desktop sizes (hover shows the label).
- Empty state: "Nothing to connect yet — add some notes, tasks or posts." when < 2 nodes.

### Added apps (2026-11-02)
`reels`, `deals`, `people`, `saved`, `voice`, `focus`, `daylog`, `bots`. Each module's header
comment lists its routes. `reels`, `daylog` and `bots` are read-only views of other PC data, and
`bots` must never gain a control: the Zora bot trades real money. Shared edit form: `web/form.js`.
Voice recording lives in the native shell (`ios/JakesData/VoiceRecorder.swift`) because a page on
plain http cannot reach the microphone; the shell sets `window.JakesData.canRecord`.

### grocery  (added 2026-11-02)
- Tile: id `grocery`, label "Groceries", colour #65a30d, glyph = shopping cart, badge = items still needed.
- Tables `grocery_items(id, name, qty TEXT, aisle TEXT, got INTEGER, created_at, updated_at)` and
  `grocery_history(key = lower-cased name PRIMARY KEY, name, qty, aisle, times, last_added)` (migration `grocery-1`).
- Aisles (fixed, store order): Produce, Bakery, Meat & Seafood, Dairy & Eggs, Pantry, Frozen, Snacks, Drinks, Household, Other.
  A POST without `aisle` uses the aisle that name had last time, else a keyword guess, else Other.
- Routes are listed in the header of `server/apps/grocery.js`.
- UI: add field; "Buy again" chips (past items not on the list); needed items grouped by aisle;
  tap the circle = in the cart, tap the name = edit sheet (item, quantity, aisle, delete);
  "In the cart" section; nav bar "Clear" empties the cart via confirmSheet.

### workout  (added 2026-11-02 — "a workout app sort of like Hevy")
- Tile: id `workout`, label "Workout", colour #2563eb, glyph = dumbbell, badge = 1 while a workout is in progress.
- Tables (migration `workout-1`): `workout_exercises` (library, ~75 built-ins seeded + custom),
  `workout_sessions`, `workout_entries` (an exercise inside a workout), `workout_sets`,
  `workout_routines` (JSON template), `workout_active` (the in-progress draft, one row).
  Weights are stored in kg, distances in metres; settings key `workout.units` ('lb' | 'kg', default lb) picks the display.
- Routes are listed in the header of `server/apps/workout.js`.
- UI: tabs Workout (start empty / resume, routines) · History (workouts-per-week chart, workout
  cards) · Exercises (library). The logger (`#/workout/active`) has a set table per exercise
  (SET · PREVIOUS · weight/reps/time/distance · check), set types (warm-up, drop, failure), a rest
  timer bar, Finish → saved workout with new records. Workouts can be edited, repeated, saved as routines.

## Desktop version (added 2026-11-02)

Jake also uses the app on the Linux PC itself, opened to the Graph. The desktop version is the
same web app in a chromeless browser window (Chrome/Chromium `--app=` mode), plus a GNOME
launcher entry, so it behaves like an installed app.

- **Core CSS for wide screens** (the `desktop` builder owns these edits in `web/styles.css`
  and, if needed, `web/launcher.js`; nothing else in core):
  `@media (min-width: 700px)`: the launcher is centred with max-width 760px, 6-column grid,
  76px tiles with 16px radius, labels 12px, dock centred with the same tile size, hover state
  (tile scales 1.04, cursor pointer); the `#app` layer centres a column of max-width 980px with
  the page background on both sides, and the nav bar spans that column — EXCEPT an app whose
  root has the class `full-bleed` (graph and the JakeTube watch page may add it), which gets the
  whole window. Keyboard: Escape = back/home. No layout change below 700px.
- `deploy/desktop/` (the `desktop` builder owns it):
  - `jakes-data.desktop` — `Name=Jake's Brain`, `Exec=<home>/jakes-data-app/deploy/desktop/open.sh %u`,
    `Icon=jakes-data`, `StartupWMClass=JakesData`, `Categories=Utility;`.
  - `open.sh [route]` — opens `http://localhost:4800/#/<route or empty>` in an app window:
    `BROWSER --app=URL --class=JakesData --user-data-dir=$HOME/.config/jakes-data-app-window --window-size=1280,860`
    where BROWSER is the first of `google-chrome`, `google-chrome-stable`, `chromium`,
    `chromium-browser`, `brave-browser` found on PATH (also look in /snap/bin and flatpak
    exports); if none, fall back to `firefox --kiosk`-less plain `firefox --new-window URL` and
    print a note. If a JakesData window is already open, just focus it (wmctrl if present,
    else open anyway).
  - `install-desktop.sh` — run ON THE PC: copies the .desktop file (with `<home>` expanded) to
    `~/.local/share/applications/`, the icon (`web/icons/icon-512.png`) to
    `~/.local/share/icons/hicolor/512x512/apps/jakes-data.png`, runs `update-desktop-database`
    and `gtk-update-icon-cache` when present, and prints how to pin it to the dash.
  - Everything must be plain bash, no sudo.

### server / settings
- `server` = the v1 Home view moved into `web/apps/server/` (no server changes).
- `settings` = the v1 About view moved into `web/apps/settings/` + rows for: Weather city
  (read-only, "set it in Weather"), JakeGPT default model (picker from `/api/jakegpt/models`
  → writes settings `gpt.model`), units. Keep "Reload" and the "How to update" blurb.

## Testing conventions (all builders)

- Local server for tests: `JAKESDATA_PORT=<your port> JAKESDATA_DATA=<scratch>/data JAKESDATA_WEB=<repo>/web JAKESDATA_CONFIG=<scratch>/config.json node server/index.js`
  — copy `server/config.json` to the scratch dir and point `fileRoots`/`videoChannels` at
  scratch folders you populate (for JakeTube make two short test MP4s with ffmpeg:
  `ffmpeg -f lavfi -i testsrc=size=640x360:rate=30 -t 8 -pix_fmt yuv420p out.mp4`).
  ffmpeg on the Mac: use `which ffmpeg` (Homebrew); if absent, say so and skip thumb tests.
- Browser checks: Playwright is at `/Users/jacobbeauchamp/.pyenv/versions/devika_python_virtual_env/bin/python`
  (`channel="chrome"`, viewport 390×844, deviceScaleFactor 2, both colour schemes, `is_mobile=True`).
  Open `http://localhost:<port>/#/<app>` and LOOK at the screenshots with the Read tool.
- Ollama on the Mac: `/opt/homebrew/bin/ollama` (`ollama serve` if not running; `ollama list`;
  pull `llama3.2:3b` if there is no model). Point tests at it with `JAKESDATA_OLLAMA`.
- Never `git commit`/`push`, never ssh to the PC, never edit files outside the directories you own.

## Deploy (deploy/) — already written by Jake's assistant, read before changing

- The PC copy at `~/jakes-data-app` is a normal git clone with
  `receive.denyCurrentBranch = updateInstead`; the Mac repo has remote `pc`.
  `deploy/deploy.sh "msg"` commits everything and `git push pc HEAD:main`; the PC's
  `.git/hooks/post-update` restarts `jakes-data.service` if `server/` or `deploy/` changed
  (web-only pushes need no restart — the server reads files from disk every request).
- `deploy/jakes-data.service` runs `node server/index.js` with the nvm node path, `Restart=always`.
