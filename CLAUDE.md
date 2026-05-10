# excalidraw-zephy — self-hosted multi-room Excalidraw

A fork of `yctimlin/mcp_excalidraw` patched for multi-room support, file-based
persistence, an admin API, a private dashboard, and Cloudflare-Tunnel public
exposure. Designed to give one user (and friends with share links) the
collaborative parts of Excalidraw+ without paying for it, plus an MCP server
so a Claude Code agent can drive any board.

Lives on **Zephy** (Ubuntu 24.04 home server, 100.121.176.61 over Tailscale).
Public URL: **https://draw.proklov.dev** via Cloudflare Tunnel.

## Where things are

| | Path / URL |
|---|---|
| Local repo (Mac dev) | `~/Documents/projects/excalidraw-zephy` |
| Zephy deploy | `/home/val/excalidraw-zephy` |
| Public canvas | `https://draw.proklov.dev/r/<room-id>` |
| Public MCP endpoint | `https://draw.proklov.dev/mcp` (bearer-token auth from dashboard's `/api/tokens` UI) |
| Admin dashboard | `https://draw-admin.proklov.dev/` — behind Cloudflare Access (Google IdP, val's Gmail only). LAN fallback: `http://zephy:5000/`. |
| Canvas REST API | `https://draw.proklov.dev/api/r/<room-id>/...` |
| Canvas WebSocket | `wss://draw.proklov.dev/ws/r/<room-id>` |
| Admin API (tailnet only) | `http://zephy:3000/api/admin/rooms` (X-Admin-Key required) |
| Admin key | `.env` on Zephy at `~/excalidraw-zephy/.env` (mode 0600) |
| Persistent state | docker named volume `excalidraw-zephy_canvas-data` → `/app/data/<room-id>.json` |
| Tunnel config | `/home/val/.cloudflared/config.yml` + `/etc/systemd/system/cloudflared.service` |
| CF Access apps | `draw-admin.proklov.dev` (Google IdP, allow `valeriyproklov501@gmail.com`, 72h session). The Access app on `draw.proklov.dev` was retired so `/r/<id>` and `/mcp` stay public. |

Two GitHub repos:
- [`Val4evr/excalidraw-zephy`](https://github.com/Val4evr/excalidraw-zephy) — canvas server + dashboard
- [`Val4evr/excalidraw-mcp`](https://github.com/Val4evr/excalidraw-mcp) — slim MCP shim (separate so `npx` install stays ~10s, not minutes)

## How it fits together

```
public internet
      │
      ├──► draw.proklov.dev ──► cloudflared ──► canvas:3000 (Docker)
      │      (no auth)                │ Express + WS, room-aware
      │                               │ /r/:roomId        → SPA HTML  (public, share-link-is-secret)
      │                               │ /api/r/:roomId/*  → REST      (public)
      │                               │ /ws/r/:roomId     → WebSocket (public)
      │                               │ /mcp              → MCP HTTP, bearer-token gated
      │                               │ /api/admin/*      → admin     (X-Admin-Key, blocked at edge anyway)
      │                               │ /                 → 302 → draw-admin.proklov.dev
      │                               ▼
      │                     canvas-data volume
      │                     /app/data/<roomId>.json (debounced, 1s)
      │
      └──► draw-admin.proklov.dev ──► CF Access (Google IdP, val Gmail) ──► cloudflared ──► dashboard:5000 (Docker)
                                                                                            serves the SPA under public/
                                                                                            injects X-Admin-Key into canvas calls
                                                                                            connector-tokens UI mints bearer tokens for /mcp

Claude.ai MCP connector ──HTTPS──► draw.proklov.dev/mcp  (bearer in Authorization header)
Mac (Claude Code) ──stdio MCP──► npx excalidraw-mcp ──HTTP──► draw.proklov.dev/api/r/<id>/*
                                  reads ROOM_ID and EXPRESS_SERVER_URL from env
```

The MCP shim's only job is to wrap each canvas REST call as an MCP tool. State
lives entirely on the canvas server. No state is duplicated in the shim.

## Codebase patches vs upstream `yctimlin/mcp_excalidraw`

What we changed (everything else is unchanged from upstream):

- **`src/types.ts`** — globals became per-room nested Maps:
  `elements: Map<roomId, Map<elementId, ServerElement>>` (and same for `files`,
  `snapshots`). Added `RoomMeta` + `roomsMeta` Map. Added helpers
  `ensureRoom`, `roomExists`, `deleteRoom`, `touchRoom`.
- **`src/server.ts`** — full rewrite of routing layer:
  - All `/api/*` routes mount under `/api/r/:roomId/*` via Express Router.
  - WS upgrade is now path-based: `/ws/r/:roomId`. Each room has its own
    `Set<WebSocket>` of clients; `broadcast(roomId, msg)` only fans within
    that room.
  - New admin router at `/api/admin/rooms` (GET/POST/PATCH/DELETE), gated by
    `X-Admin-Key` matching `ADMIN_API_KEY` env.
  - Bare `/` returns 404; SPA HTML serves at `/r/:roomId/`.
  - Static asset middleware uses `{index: false}` so root falls through to 404.
  - Calls `loadAll()` on boot, registers SIGTERM/SIGINT → `flushAll()`.
- **`src/persistence.ts`** (new) — `loadAll()`, `markDirty(roomId)` with 1s
  debounce, `flushAll()`, atomic temp-file writes via `rename`. Reads
  `DATA_DIR` env, default `/app/data`.
- **`frontend/src/App.tsx`** — derives `ROOM_ID` from `window.location.pathname`,
  injects into all `/api/*` URLs and the WS connect URL. Renders a
  `BoardNotFound` view if the path doesn't match `/r/<id>`.
- **`src/index.ts`** (MCP shim) — has no `ROOM_ID` env. Every canvas tool
  resolves the active room via `set_room` (or per-call `roomUrl`/`roomId`
  args). Prepends `/r/<id>` to every canvas URL.
- **`src/embedHtml.ts`** (new) — inlined HTML resource served at
  `ui://excalidraw-zephy/embed.html` per the [MCP Apps protocol][mcp-apps].
  When `set_room` or `show_canvas` is called on an Apps-aware host
  (Claude.ai), the host renders this iframe wrapper inline, which then
  points at our existing `/r/<id>?embed=1` route. Hosts without Apps
  support ignore the `_meta.ui.resourceUri` hint and just see text content.
  [mcp-apps]: https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/
- **`frontend/src/App.tsx`** has an `EMBED_MODE` flag (set when URL has
  `?embed=1`) that hides the header bar so the canvas owns the full
  iframe viewport.
- **`Dockerfile.canvas`** — adds `VOLUME /app/data`, `DATA_DIR=/app/data`,
  `nodejs` user owns the volume.
- **`docker-compose.yml`** — named volume `canvas-data` (avoids host bind-mount
  permission issues), adds `dashboard` service, `ADMIN_API_KEY` from `.env`.
- **`dashboard/`** (new) — Express proxy on `:5000` that forwards
  `/api/rooms/*` to canvas's `/api/admin/rooms/*` with the admin key injected
  server-side. Static SPA in `dashboard/public/` (vanilla HTML/CSS/JS;
  Instrument Serif title, IBM Plex Sans body, JetBrains Mono code, accent
  `#6c7cff`, dark by default with localStorage-persisted toggle). The SPA
  has two visible sections: the boards list (rename/delete inline) and an
  **Install MCP server** section that composes per-platform install snippets
  (Claude Code shell, Codex TOML, Cursor JSON, generic JSON, claude.ai URL)
  client-side from `PUBLIC_BASE_URL` + the room picked in a dropdown. The
  earlier "Connector tokens" UI was removed when `/mcp` switched to
  unauthenticated mode (`MCP_REQUIRE_AUTH=false`); the canvas-side token
  endpoints in `tokens.ts` are still wired and reachable via X-Admin-Key on
  `/api/admin/tokens` if you ever flip auth back on.

## Auto-snapshots

The canvas server runs a background loop (`takeAutoSnapshots` in `src/server.ts`)
that snapshots every changed room periodically:

- `AUTO_SNAPSHOT_INTERVAL_MS` (default 600000 = 10 min)
- `AUTO_SNAPSHOT_KEEP`         (default 15 newest `auto-*` per room)

Snapshots are named `auto-<ISO-timestamp>`. They live inside the room's JSON
file alongside elements, and are pruned to the configured keep count. Manual
snapshots (any non-`auto-` name) are never touched. Rooms whose `updatedAt`
hasn't advanced since the last auto-snapshot are skipped — no churn for
inactive rooms. To restore one, use the `restore_snapshot` MCP tool or
`GET /api/r/<id>/snapshots/<name>`.

## OpenGraph / Twitter cards

Per-room HTML (the SPA served at `/r/<id>`) is rendered through
`renderRoomHtml()` which injects:
- `<title>{room name} · Excalidraw / Zephy</title>`
- `og:title`, `og:url`, `og:image`, `og:description`, `og:site_name`
- `twitter:card=summary_large_image`, plus matching `twitter:*` tags

Static og-image at `/og-image.png` (1200×630), bundled via `frontend/public/`.
Sharing a `/r/<id>` link in Slack/Discord/iMessage/Twitter renders a card
with the board name as the headline.

## Operational cheat sheet

```bash
# Status
ssh val@100.121.176.61 'docker compose -f ~/excalidraw-zephy/docker-compose.yml ps'
ssh val@100.121.176.61 'systemctl status cloudflared --no-pager | head -8'

# Logs
ssh val@100.121.176.61 'docker logs --tail 50 excalidraw-canvas'
ssh val@100.121.176.61 'docker logs --tail 50 excalidraw-dashboard'

# Restart canvas (preserves data via volume)
ssh val@100.121.176.61 'docker compose -f ~/excalidraw-zephy/docker-compose.yml restart canvas'

# Pull + rebuild + restart after pushing changes to GitHub
ssh val@100.121.176.61 'cd ~/excalidraw-zephy && git pull && docker compose up -d --build'

# Create a board from CLI (admin key required)
KEY=$(ssh val@100.121.176.61 'grep ADMIN_API_KEY ~/excalidraw-zephy/.env | cut -d= -f2')
curl -s -H "X-Admin-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"name":"my board"}' http://zephy:3000/api/admin/rooms

# Or just use the dashboard at http://zephy:5000

# Install MCP server for a board (the dashboard's "Copy MCP install" emits this)
claude mcp add excalidraw -s user \
  --env ROOM_ID=<from-dashboard> \
  --env EXPRESS_SERVER_URL=http://zephy:3000 \
  -- npx -y --package=github:Val4evr/excalidraw-mcp excalidraw-mcp
```

## Security model

- **Admin endpoints** at `/api/admin/*` are tailnet-only (canvas binds `127.0.0.1:3000` on Zephy and the cloudflared ingress doesn't route those paths).
- **Room access** is by share-link only. Room IDs are 12-char nanoids (~6×10²⁰ space) — same model as Google Docs share links. CORS is `*` by design; knowing the id IS the secret.
- **Dashboard** has no built-in auth. **Cloudflare Access fronts `draw-admin.proklov.dev`** (Google IdP, val's Gmail only, 72h session) and is the boundary. The earlier "tailnet only" posture was retired in favor of CF Access so val can hit the dashboard from any device.
- **`/mcp` endpoint** is publicly reachable on `draw.proklov.dev/mcp`. By default it requires a bearer token from the dashboard's `/api/tokens` UI. **`MCP_REQUIRE_AUTH=false` in `.env` disables the bearer check** — Claude.ai's connector dialog only speaks OAuth (no raw bearer field), so this opt-in lets it attach. With auth off, security collapses to "knowing a room id is the secret" (same model as `/r/<id>` share links).
- **Friends without Tailscale or Google login** open `https://draw.proklov.dev/r/<id>` directly — no auth at all on `/r/`.
- **Bare `/` redirects to `draw-admin.proklov.dev`** (via canvas's `ROOT_REDIRECT_URL` env), which then requires Google login. `/r/<bogus>` returns 404 — no info leak.

## What's been tested

End-to-end browser walkthrough plus a 14-test deep pass — all green:

| Area | Coverage |
|---|---|
| Dashboard UX | new / rename (Enter saves, Esc cancels) / delete (with confirm modal) / theme toggle (persists) / copy share link / copy MCP install / XSS-safe rendering / empty-name validation |
| Public board view | loads via Cloudflare Tunnel, WS connects, API write renders live, two tabs sync via WS broadcast, reload retains state |
| Concurrency | 100 parallel writes (zero id collisions), 60-write human+agent simultaneous, 5-room isolation |
| Throughput | 1k batch in 450ms, 30s sustained 10/sec @ ~2.2% CPU |
| Persistence | restart preserves state with crypto-matching id set; corrupt JSON skipped gracefully |
| Networking | tailnet 10ms / Cloudflare 76ms median latency; tunnel SIGKILL → systemd restart in 5s, browser auto-reconnects WS |
| Files | image upload + persist + delete |
| Export | PNG + SVG round-trip via frontend rendering |
| Edge cases | bare URL, bogus room, URL with spaces, malformed JSON body, wrong/missing admin key, 187-char names, mobile CSS rules |

Resource use on Zephy at idle: canvas ~29 MiB, dashboard ~27 MiB, ~0% CPU.
Under load: 1480 elements added ~5 MiB, sustained 10/sec held 2% CPU. There is
hundreds of MiB of headroom before this becomes interesting.

## Known caveats

- **MCP image export needs a connected browser** — the WS broadcasts the export
  request; the frontend renders via Excalidraw's `exportToBlob`/`exportToSvg`
  and POSTs back. With no browser open to that room, the call returns
  503 "No frontend client connected for this room."
- **`prepare` script in package.json** runs `npm run build:server || true`. The
  `|| true` is intentional: stage 1 of `Dockerfile.canvas` runs `npm ci`
  before `src/` is copied, so tsc has nothing to compile and exits non-zero;
  the `|| true` lets `npm ci` succeed.
- **Tunnel SIGINT vs SIGKILL**: `systemctl Restart=on-failure` only triggers
  on non-zero exit codes. A `kill -INT cloudflared` exits cleanly so systemd
  doesn't restart it. SIGKILL (or real failures like OOM/network drop) do
  trigger restart.
- **No rate limiting** on the canvas. Mostly fine because room IDs are
  unguessable, but a determined attacker who has a room id can flood it.
  Worth noting if this ever ships beyond personal use.

## Working on the code

```bash
# Local dev (Mac, both run in foreground for fast iteration)
cd ~/Documents/projects/excalidraw-zephy
npm install
npm run build           # builds frontend + server
DATA_DIR=$(pwd)/data ADMIN_API_KEY=devkey HOST=127.0.0.1 PORT=3030 \
  PUBLIC_BASE_URL="http://localhost:3030" \
  node dist/server.js

# In another terminal, dashboard
cd dashboard
npm install
CANVAS_URL=http://127.0.0.1:3030 ADMIN_API_KEY=devkey HOST=127.0.0.1 PORT=5050 \
  PUBLIC_BASE_URL="http://localhost:3030" \
  node src/server.js

# Then open http://localhost:5050/ for the dashboard
# Create a board, visit http://localhost:3030/r/<id>
```

The MCP shim repo (`Val4evr/excalidraw-mcp`) duplicates a slim subset of the
schema types from this repo. If you change `ServerElement` shape or add a new
element type, check both repos for sync.

## When to update this doc

This file is loaded into Claude's context when you `cd` into the repo. Keep it
truthful. If you change architecture (different proxy, different DB, different
auth model), update the diagram and the file paths. If you find a new caveat
worth a future session knowing about, drop it in **Known caveats**.
