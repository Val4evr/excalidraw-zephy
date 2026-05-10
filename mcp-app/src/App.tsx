import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Excalidraw, convertToExcalidrawElements } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { useApp } from '@modelcontextprotocol/ext-apps/react';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// What the canvas server returns from /api/r/<id>/elements. Keys roughly match
// the upstream Excalidraw element shape but with server-only metadata
// (createdAt/updatedAt/syncedAt/version/source) stripped at render time.
type ServerElement = {
  id: string;
  type: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  text?: string;
  label?: { text: string };
  startBinding?: unknown;
  endBinding?: unknown;
  start?: unknown;
  end?: unknown;
  // …and many more passthrough fields we don't enumerate
  [key: string]: unknown;
};

type RoomTarget = {
  serverUrl: string;   // https://draw.proklov.dev
  roomId: string;
  apiBase: string;     // https://draw.proklov.dev/api/r/<id>
  roomUrl: string;     // https://draw.proklov.dev/r/<id>
};

const ROOM_URL_RE = /https?:\/\/[^\s)>"']*\/r\/[A-Za-z0-9_-]+/;

function parseRoomUrl(roomUrl: string): RoomTarget | null {
  try {
    const u = new URL(roomUrl);
    const m = u.pathname.match(/\/r\/([A-Za-z0-9_-]+)/);
    if (!m?.[1]) return null;
    const roomId = decodeURIComponent(m[1]);
    return {
      serverUrl: u.origin,
      roomId,
      apiBase: `${u.origin}/api/r/${roomId}`,
      roomUrl: `${u.origin}/r/${roomId}`,
    };
  } catch {
    return null;
  }
}

// Strip server-only fields and coerce label-bearing shapes back into
// Excalidraw's labeled-container format. This mirrors `cleanElementForExcalidraw`
// in frontend/src/App.tsx — kept locally so the bundle is self-contained.
function toExcalidrawInitial(elements: ServerElement[]): readonly ExcalidrawElement[] {
  // convertToExcalidrawElements is the recommended path: it fills in defaults
  // (versionNonce, seed, isDeleted, etc.) and sanitizes shape so updateScene
  // doesn't choke on partial server payloads.
  const cleaned = elements.map(({ createdAt, updatedAt, syncedAt, version, source, syncTimestamp, ...rest }) => rest);
  return convertToExcalidrawElements(cleaned as Parameters<typeof convertToExcalidrawElements>[0]);
}

// Pull a room URL out of whatever shape the host hands us. We look at
// `structuredContent.roomUrl` first (what set_room/show_canvas populates),
// then `.url`, then scan text content as a last resort.
function extractRoomUrl(result: CallToolResult | undefined): string | null {
  if (!result) return null;
  const sc = (result as { structuredContent?: Record<string, unknown> }).structuredContent;
  if (sc && typeof sc === 'object') {
    if (typeof sc.roomUrl === 'string') return sc.roomUrl;
    if (typeof sc.url === 'string') return sc.url;
  }
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (block && (block as { type?: string }).type === 'text') {
        const text = (block as { text?: string }).text;
        if (typeof text === 'string') {
          const m = text.match(ROOM_URL_RE);
          if (m) return m[0];
        }
      }
    }
  }
  return null;
}

export function App() {
  const [room, setRoom] = useState<RoomTarget | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { app, isConnected, error: appError } = useApp({
    appInfo: { name: 'excalidraw-zephy/mcp-app', version: '1.0.0' },
    capabilities: {},
    onAppCreated: (a) => {
      // Tool result fires once per tool call. set_room/show_canvas both
      // include structuredContent.roomUrl, so this is where we pick up
      // (or switch) the active canvas.
      a.ontoolresult = (result: CallToolResult) => {
        const url = extractRoomUrl(result);
        if (!url) return;
        const next = parseRoomUrl(url);
        if (next) setRoom(next);
      };
      a.onerror = (e) => setError(String(e));
    },
  });

  if (appError) {
    return <ErrorView message={`Failed to connect to MCP host: ${appError.message}`} />;
  }
  if (!isConnected) {
    return <Placeholder text="Connecting to host…" />;
  }
  if (error) {
    return <ErrorView message={error} />;
  }
  if (!room) {
    return (
      <Placeholder text={
        'Waiting for set_room. Paste a room URL like https://draw.proklov.dev/r/<id> in chat.'
      } />
    );
  }
  return <CanvasView room={room} app={app} key={room.roomId} />;
}

function Placeholder({ text }: { text: string }) {
  return <div className="placeholder">{text}</div>;
}

function ErrorView({ message }: { message: string }) {
  return (
    <>
      <div className="error-banner">{message}</div>
      <Placeholder text="See banner above." />
    </>
  );
}

// ─────────────────────────────────────────────────────────────────
// CanvasView — owns one room. Loads initial elements, opens WS,
// renders Excalidraw, syncs user edits back to the canvas server.
// Re-mounted (via key={roomId}) when set_room switches rooms.
// ─────────────────────────────────────────────────────────────────

function CanvasView({ room, app }: { room: RoomTarget; app: ReturnType<typeof useApp>['app'] }) {
  const [initialElements, setInitialElements] = useState<readonly ExcalidrawElement[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // Track which elements (by id+version) we last pushed so onChange diffing
  // can ignore the round-trip from our own writes.
  const lastSyncedRef = useRef<Map<string, number>>(new Map());
  // Suppress applying server broadcasts that originated from our own writes.
  const ourClientId = useMemo(
    () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)),
    [],
  );

  // 1. Load initial scene -------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setInitialElements(null);
    setLoadError(null);
    fetch(`${room.apiBase}/elements`, { headers: { Accept: 'application/json' } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        const data = (await res.json()) as { elements?: ServerElement[] };
        if (cancelled) return;
        const elems = Array.isArray(data.elements) ? data.elements : [];
        setInitialElements(toExcalidrawInitial(elems));
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setLoadError(err.message || String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [room.apiBase]);

  // 2. WebSocket subscription --------------------------------------------
  useEffect(() => {
    const wsUrl = room.serverUrl.replace(/^http/, 'ws') + `/ws/r/${room.roomId}`;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let stopped = false;

    const connect = () => {
      socket = new WebSocket(wsUrl);
      wsRef.current = socket;
      socket.addEventListener('open', () => {
        attempts = 0;
        try {
          socket?.send(JSON.stringify({ type: 'client_join', clientId: ourClientId, source: 'mcp-app' }));
        } catch { /* socket may have closed mid-send */ }
      });
      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return;
        let msg: { type?: string; clientId?: string; elements?: ServerElement[]; element?: ServerElement; id?: string };
        try { msg = JSON.parse(event.data); } catch { return; }
        if (!msg.type) return;
        // Ignore broadcasts that echoed our own writes — we already applied them locally.
        if (msg.clientId === ourClientId) return;
        applyIncoming(msg);
      });
      socket.addEventListener('close', () => {
        wsRef.current = null;
        if (stopped) return;
        attempts = Math.min(attempts + 1, 6);
        const delay = Math.min(15000, 500 * 2 ** attempts);
        reconnectTimer = setTimeout(connect, delay);
      });
      socket.addEventListener('error', () => {
        try { socket?.close(); } catch { /* already closed */ }
      });
    };
    connect();

    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try { socket?.close(); } catch { /* swallow */ }
    };
  }, [room.serverUrl, room.roomId, ourClientId]);

  // Apply a server broadcast to the live Excalidraw scene.
  const applyIncoming = useCallback((msg: {
    type?: string;
    elements?: ServerElement[];
    element?: ServerElement;
    id?: string;
  }) => {
    const api = apiRef.current;
    if (!api) return;
    const current = api.getSceneElementsIncludingDeleted();
    const byId = new Map<string, ExcalidrawElement>(current.map((el) => [el.id, el]));

    const upsert = (raw: ServerElement | undefined) => {
      if (!raw?.id) return;
      const skeleton = [raw] as unknown as Parameters<typeof convertToExcalidrawElements>[0];
      const [converted] = convertToExcalidrawElements(skeleton);
      if (converted) byId.set(raw.id, converted);
    };
    const remove = (id: string | undefined) => {
      if (!id) return;
      const existing = byId.get(id);
      if (existing) byId.set(id, { ...existing, isDeleted: true });
    };

    switch (msg.type) {
      case 'initial_elements':
      case 'elements_synced':
      case 'elements_batch_created':
        for (const el of msg.elements ?? []) upsert(el);
        break;
      case 'elements_patched':
        for (const el of msg.elements ?? []) upsert(el);
        break;
      case 'element_created':
      case 'element_updated':
        upsert(msg.element);
        break;
      case 'element_deleted':
        remove(msg.id ?? msg.element?.id);
        break;
      default:
        // pointer_update, client_disconnected, files_added — ignored in v1
        return;
    }

    api.updateScene({ elements: Array.from(byId.values()) });
    for (const el of byId.values()) {
      if (el && !el.isDeleted) lastSyncedRef.current.set(el.id, el.version ?? 0);
    }
  }, []);

  // 3. Outbound: debounced sync of local edits back to the server -------
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingScenesRef = useRef<readonly ExcalidrawElement[] | null>(null);

  const onChange = useCallback((elements: readonly ExcalidrawElement[]) => {
    pendingScenesRef.current = elements;
    if (syncTimerRef.current) return;
    syncTimerRef.current = setTimeout(() => {
      syncTimerRef.current = null;
      const scene = pendingScenesRef.current;
      pendingScenesRef.current = null;
      if (!scene) return;
      flushScene(scene);
    }, 800);
  }, [room.apiBase, ourClientId]);

  const flushScene = useCallback((elements: readonly ExcalidrawElement[]) => {
    const lastSynced = lastSyncedRef.current;
    const seen = new Set<string>();
    const created: ExcalidrawElement[] = [];
    const updated: ExcalidrawElement[] = [];
    const deleted: string[] = [];
    for (const el of elements) {
      seen.add(el.id);
      if (el.isDeleted) {
        if (lastSynced.has(el.id)) {
          deleted.push(el.id);
          lastSynced.delete(el.id);
        }
        continue;
      }
      const prevVersion = lastSynced.get(el.id);
      if (prevVersion === undefined) {
        created.push(el);
      } else if ((el.version ?? 0) !== prevVersion) {
        updated.push(el);
      }
    }
    for (const id of lastSynced.keys()) {
      if (!seen.has(id)) deleted.push(id);
    }

    // Mark the post-sync state so the next onChange diffs against it.
    for (const el of [...created, ...updated]) lastSynced.set(el.id, el.version ?? 0);
    for (const id of deleted) lastSynced.delete(id);

    const tasks: Promise<unknown>[] = [];
    if (created.length || updated.length) {
      tasks.push(
        fetch(`${room.apiBase}/elements/sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientId: ourClientId,
            elements: [...created, ...updated],
          }),
        }).catch(() => { /* best-effort; WS reconnect will re-sync */ }),
      );
    }
    for (const id of deleted) {
      tasks.push(
        fetch(`${room.apiBase}/elements/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers: { 'X-Client-Id': ourClientId },
        }).catch(() => { /* best-effort */ }),
      );
    }
    Promise.all(tasks).catch(() => { /* swallow */ });
  }, [room.apiBase, ourClientId]);

  if (loadError) {
    return <ErrorView message={`Loading room ${room.roomId} failed: ${loadError}`} />;
  }
  if (initialElements === null) {
    return <Placeholder text={`Loading ${room.roomId}…`} />;
  }
  return (
    <>
      <div className="topbar">
        <a href={room.roomUrl} target="_blank" rel="noopener">
          {new URL(room.roomUrl).host + new URL(room.roomUrl).pathname}
        </a>
        <span className="grow" />
        <span style={{ fontSize: 11, opacity: 0.7 }}>{initialElements.length} elements</span>
      </div>
      <div className="canvas-host">
        <Excalidraw
          excalidrawAPI={(api) => { apiRef.current = api; }}
          initialData={{
            elements: initialElements,
            appState: { theme: 'light', viewBackgroundColor: '#ffffff' },
          }}
          onChange={onChange}
          isCollaborating={true}
        />
      </div>
    </>
  );
}
