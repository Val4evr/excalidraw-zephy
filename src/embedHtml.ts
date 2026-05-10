// Static HTML for the MCP App view. Served as a single resource at
// `ui://excalidraw-zephy/embed.html` so MCP-Apps-aware hosts (e.g. claude.ai)
// can render a live canvas iframe inline next to the assistant message.
//
// The wrapper is intentionally minimal: it listens for tool-result postMessages
// from the host, extracts the active room URL from `structuredContent.roomUrl`
// (or scans text content as a fallback), and points an iframe at our existing
// `/r/<id>?embed=1` route. The canvas SPA's `?embed=1` mode hides its chrome
// so the iframe gets every available pixel.
//
// We inline the HTML as a TS module rather than `fs.readFileSync` from a sibling
// .html file so the production bundle is a single JS file with no path
// resolution at runtime — no Dockerfile changes needed.
//
// MCP Apps protocol reference: https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/

// Bumped from embed.html → embed-v2.html on 2026-05-11 to force claude.ai to
// invalidate its cached resource (metadata + JS). The previous URI's CSP was
// stuck at scheme-only values even after connector remove/re-add.
export const EMBED_RESOURCE_URI = 'ui://excalidraw-zephy/embed-v2.html';
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';

export const EMBED_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Excalidraw / Zephy</title>
  <style>
    html, body {
      margin: 0;
      padding: 0;
      height: 100%;
      background: #ffffff;
      color: #1e1e1e;
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    @media (prefers-color-scheme: dark) {
      html, body { background: #121212; color: #e8e8e8; }
    }
    #root {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      min-height: 540px;
    }
    .placeholder {
      display: flex;
      flex: 1;
      align-items: center;
      justify-content: center;
      padding: 24px;
      text-align: center;
      font-size: 14px;
      line-height: 1.5;
      color: #777;
    }
    .placeholder code {
      font-family: ui-monospace, "JetBrains Mono", "SF Mono", Menlo, monospace;
      font-size: 13px;
      padding: 2px 5px;
      border-radius: 4px;
      background: rgba(127, 127, 127, 0.15);
    }
    iframe {
      flex: 1;
      width: 100%;
      border: 0;
      background: transparent;
      display: block;
    }
    .topbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      font-size: 12px;
      color: #666;
      border-bottom: 1px solid rgba(127, 127, 127, 0.18);
      background: rgba(127, 127, 127, 0.04);
    }
    .topbar a {
      color: inherit;
      text-decoration: none;
      font-family: ui-monospace, "JetBrains Mono", "SF Mono", Menlo, monospace;
      font-size: 12px;
      opacity: 0.85;
    }
    .topbar a:hover { opacity: 1; text-decoration: underline; }
    .topbar .grow { flex: 1; }
    .topbar button {
      font: inherit;
      color: inherit;
      background: transparent;
      border: 1px solid rgba(127, 127, 127, 0.3);
      border-radius: 4px;
      padding: 2px 8px;
      cursor: pointer;
    }
    .topbar button:hover { background: rgba(127, 127, 127, 0.12); }
  </style>
</head>
<body>
  <div id="root">
    <div class="placeholder" id="placeholder">
      Waiting for room… If this never resolves, call <code>set_room</code> with your room URL.
    </div>
  </div>

  <script>
    // MCP Apps host pushes tool data to this iframe via postMessage. We only
    // care about three things: the latest tool-result (which carries the
    // active room URL in structuredContent), the host-context-changed
    // notification (carries display mode + theme on first paint), and a
    // user-initiated "expand" click that asks the host to upgrade us to
    // fullscreen.
    //
    // Everything else (canvas drawing, real-time sync, persistence) happens
    // inside the iframe itself by virtue of pointing at our existing
    // /r/<id>?embed=1 route.

    const root = document.getElementById('root');
    const placeholder = document.getElementById('placeholder');
    let currentRoomUrl = null;

    function renderCanvas(roomUrl) {
      if (!roomUrl || roomUrl === currentRoomUrl) return;
      currentRoomUrl = roomUrl;

      // Strip any existing fragment, append/merge ?embed=1 so the canvas SPA
      // hides its chrome (header bar, status pill) and gives the iframe its
      // full pixel budget.
      let url;
      try {
        url = new URL(roomUrl);
      } catch {
        placeholder.textContent = 'Invalid room URL: ' + roomUrl;
        return;
      }
      url.searchParams.set('embed', '1');

      while (root.firstChild) root.removeChild(root.firstChild);

      const bar = document.createElement('div');
      bar.className = 'topbar';
      const link = document.createElement('a');
      link.href = roomUrl;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = url.host + url.pathname;
      bar.appendChild(link);
      const grow = document.createElement('span');
      grow.className = 'grow';
      bar.appendChild(grow);
      const expand = document.createElement('button');
      expand.type = 'button';
      expand.textContent = 'Fullscreen';
      expand.title = 'Open as fullscreen widget';
      expand.addEventListener('click', () => requestDisplayMode('fullscreen'));
      bar.appendChild(expand);
      root.appendChild(bar);

      const frame = document.createElement('iframe');
      frame.src = url.toString();
      frame.allow = 'clipboard-read; clipboard-write';
      frame.referrerPolicy = 'no-referrer';
      root.appendChild(frame);

      // CSP diagnostics: if the nested iframe never fires `load` within 2s,
      // it almost certainly got blocked by the host's frame-src directive.
      // Surface a visible fallback so the user sees what happened instead
      // of staring at an empty box. The link still works as an escape hatch.
      let loaded = false;
      frame.addEventListener('load', () => { loaded = true; });
      setTimeout(() => {
        if (loaded) return;
        const note = document.createElement('div');
        note.className = 'placeholder';
        note.style.position = 'absolute';
        note.style.inset = '0';
        note.style.background = 'rgba(0,0,0,0.05)';
        note.innerHTML =
          'Inline canvas blocked by host CSP. ' +
          'Open <a href="' + roomUrl + '" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline">' +
          url.host + url.pathname + '</a> in a new tab.';
        root.appendChild(note);
      }, 2000);
    }

    function jsonRpcNotify(method, params) {
      try {
        window.parent.postMessage({ jsonrpc: '2.0', method, params }, '*');
      } catch (e) {
        // Host may not be ready; silent.
      }
    }

    function requestDisplayMode(mode) {
      // Best-effort. Hosts that don't support display-mode requests will
      // ignore this; the user can still click the room link to open in a
      // new tab.
      try {
        window.parent.postMessage({
          jsonrpc: '2.0',
          id: 'display-mode-' + Date.now(),
          method: 'ui/request-display-mode',
          params: { mode }
        }, '*');
      } catch {}
    }

    function extractRoomUrl(result) {
      if (!result) return null;
      const sc = result.structuredContent;
      if (sc && typeof sc === 'object') {
        if (typeof sc.roomUrl === 'string') return sc.roomUrl;
        if (typeof sc.url === 'string') return sc.url;
      }
      // Fall back to scanning text content for a /r/<id> URL.
      if (Array.isArray(result.content)) {
        for (const block of result.content) {
          if (block && block.type === 'text' && typeof block.text === 'string') {
            const m = block.text.match(/https?:\\/\\/[^\\s)>"']*\\/r\\/[A-Za-z0-9_-]+/);
            if (m) return m[0];
          }
        }
      }
      return null;
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg || typeof msg !== 'object') return;
      const method = msg.method;
      if (!method) return;

      if (method === 'ui/notifications/tool-result' || method === 'tool-result') {
        // Tolerate a couple of plausible shapes: hosts that put the
        // CallToolResult directly in params, and hosts that nest it under
        // params.result.
        const payload = msg.params || msg.result;
        const url = extractRoomUrl(payload) || (payload && extractRoomUrl(payload.result));
        if (url) renderCanvas(url);
      } else if (method === 'ui/notifications/host-context-changed' || method === 'host-context-changed') {
        // No-op for now; theme follows OS via prefers-color-scheme.
      }
    });

    // Some hosts deliver an initial size notification which we mirror back
    // so they know our preferred minimum. The canvas itself fills the
    // iframe via flex:1.
    requestAnimationFrame(() => {
      jsonRpcNotify('ui/notifications/size-changed', {
        width: document.documentElement.clientWidth,
        height: 540
      });
    });
  </script>
</body>
</html>
`;
