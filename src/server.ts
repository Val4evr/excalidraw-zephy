import express, { Request, Response, NextFunction, Router } from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer, IncomingMessage } from 'http';
import { randomBytes } from 'crypto';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import logger from './utils/logger.js';
import {
  elements,
  files,
  snapshots,
  roomsMeta,
  ensureRoom,
  roomExists,
  deleteRoom,
  touchRoom,
  generateId,
  EXCALIDRAW_ELEMENT_TYPES,
  ServerElement,
  ExcalidrawElementType,
  ExcalidrawFile,
  WebSocketMessage,
  ElementCreatedMessage,
  ElementUpdatedMessage,
  ElementDeletedMessage,
  BatchCreatedMessage,
  SyncStatusMessage,
  InitialElementsMessage,
  PointerUpdateMessage,
  ElementsPatchedMessage,
  Snapshot,
  RoomMeta,
  normalizeFontFamily
} from './types.js';
import { z } from 'zod';
import WebSocket from 'ws';
import { loadAll, markDirty, flushAll, deleteRoomFile } from './persistence.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Frontend assets are served at root because the bundled Excalidraw worker
// loads fonts via absolute URLs like /assets/fonts/... — this MUST stay at /
// even though the SPA HTML is served per-room at /r/:roomId.
// index: false → don't auto-serve index.html on directory requests; that lets
// the bare "/" route fall through to our 404 handler. Per-room SPA HTML is served
// by the explicit /r/:roomId route below.
app.use(express.static(path.join(__dirname, '../dist/frontend'), { index: false }));
app.use('/assets/fonts', express.static(
  path.join(__dirname, '../node_modules/@excalidraw/excalidraw/dist/prod/fonts')
));

// ─── Room registry helpers ──────────────────────────────────────
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const ROOT_REDIRECT_URL = (process.env.ROOT_REDIRECT_URL || '').replace(/\/$/, '');
const AUTO_SNAPSHOT_INTERVAL_MS = parseInt(process.env.AUTO_SNAPSHOT_INTERVAL_MS || '600000', 10);
const AUTO_SNAPSHOT_KEEP = parseInt(process.env.AUTO_SNAPSHOT_KEEP || '15', 10);
const SYNC_DEBUG = process.env.SYNC_DEBUG === 'true';

interface ElementClock {
  version: number;
  updated: number;
}

const deletedElementTombstones = new Map<string, Map<string, ElementClock>>();

function elementClock(element: Partial<ServerElement> | undefined): ElementClock {
  const version = typeof element?.version === 'number' && Number.isFinite(element.version) ? element.version : 0;
  const updated = typeof element?.updated === 'number' && Number.isFinite(element.updated) ? element.updated : 0;
  return { version, updated };
}

function shouldAcceptIncomingElement(existing: ServerElement | undefined, incoming: ServerElement): boolean {
  if (!existing) return true;
  const existingClock = elementClock(existing);
  const incomingClock = elementClock(incoming);
  if (incomingClock.version !== existingClock.version) return incomingClock.version > existingClock.version;
  return incomingClock.updated >= existingClock.updated;
}

function getRoomTombstones(roomId: string): Map<string, ElementClock> {
  let tombstones = deletedElementTombstones.get(roomId);
  if (!tombstones) {
    tombstones = new Map();
    deletedElementTombstones.set(roomId, tombstones);
  }
  return tombstones;
}

function rememberDeletedElement(roomId: string, element: ServerElement | undefined, id: string): void {
  const tombstones = getRoomTombstones(roomId);
  const current = tombstones.get(id);
  const next = elementClock(element);
  if (!current || next.version > current.version || next.updated > current.updated) {
    tombstones.set(id, next);
  }
}

function isTombstonedStaleElement(roomId: string, element: ServerElement): boolean {
  const tombstone = getRoomTombstones(roomId).get(element.id);
  if (!tombstone) return false;
  const incoming = elementClock(element);
  const stale =
    incoming.version < tombstone.version ||
    (incoming.version === tombstone.version && incoming.updated <= tombstone.updated);
  if (!stale) {
    getRoomTombstones(roomId).delete(element.id);
  }
  return stale;
}

function syncDebug(message: string, details: Record<string, unknown>): void {
  if (!SYNC_DEBUG) return;
  logger.info(`[sync-debug] ${message}`, details);
  console.info(`[sync-debug] ${message} ${JSON.stringify(details)}`);
}

function summarizeServerElement(element: Partial<ServerElement> | undefined): Record<string, unknown> | null {
  if (!element) return null;
  return {
    id: element.id,
    type: element.type,
    x: element.x,
    y: element.y,
    version: element.version,
    updated: element.updated,
    isDeleted: element.isDeleted,
    source: element.source,
  };
}

function newRoomId(): string {
  return randomBytes(9).toString('base64url'); // 12 chars URL-safe
}

function shareUrlFor(roomId: string): string {
  return `${PUBLIC_BASE_URL || ''}/r/${roomId}`;
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!ADMIN_API_KEY) {
    res.status(500).json({ success: false, error: 'ADMIN_API_KEY not configured on server' });
    return;
  }
  if (req.header('X-Admin-Key') !== ADMIN_API_KEY) {
    res.status(401).json({ success: false, error: 'Invalid or missing X-Admin-Key' });
    return;
  }
  next();
}

// Resolve roomId param + load the room's inner Maps onto res.locals.
function loadRoom(req: Request, res: Response, next: NextFunction): void {
  const roomId = req.params.roomId;
  if (!roomId || !roomExists(roomId)) {
    res.status(404).json({ success: false, error: `Room ${roomId} not found` });
    return;
  }
  res.locals.roomId = roomId;
  res.locals.roomEl = elements.get(roomId)!;
  res.locals.roomFiles = files.get(roomId)!;
  res.locals.roomSnaps = snapshots.get(roomId)!;
  next();
}

// ─── WebSocket: per-room client sets + broadcast ────────────────
const clientsByRoom = new Map<string, Set<WebSocket>>();

type RoomWebSocket = WebSocket & {
  roomId?: string;
  clientId?: string;
  username?: string | null;
  color?: {
    background: string;
    stroke: string;
  };
};

function getRoomClients(roomId: string): Set<WebSocket> {
  let set = clientsByRoom.get(roomId);
  if (!set) {
    set = new Set();
    clientsByRoom.set(roomId, set);
  }
  return set;
}

function broadcast(
  roomId: string,
  message: WebSocketMessage,
  options: { exclude?: WebSocket; excludeClientId?: string } = {}
): void {
  const set = clientsByRoom.get(roomId);
  if (!set) return;
  const data = JSON.stringify(message);
  set.forEach(client => {
    try {
      const metaClient = client as RoomWebSocket;
      if (options.exclude && client === options.exclude) return;
      if (options.excludeClientId && metaClient.clientId === options.excludeClientId) return;
      if (client.readyState === WebSocket.OPEN) client.send(data);
    } catch (err) {
      logger.warn('Failed to send to client, removing');
      set!.delete(client);
    }
  });
}

const WS_ROOM_RE = /^\/ws\/r\/([A-Za-z0-9_-]+)\/?$/;

server.on('upgrade', (req: IncomingMessage, socket, head) => {
  const url = req.url || '';
  const m = url.match(WS_ROOM_RE);
  if (!m) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  const roomId = m[1];
  if (!roomId || !roomExists(roomId)) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    (ws as RoomWebSocket).roomId = roomId;
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws: WebSocket) => {
  const roomWs = ws as RoomWebSocket;
  const roomId = roomWs.roomId as string;
  const set = getRoomClients(roomId);
  set.add(ws);
  logger.info(`WS connected to room ${roomId} (clients: ${set.size})`);

  const roomEl = elements.get(roomId);
  const roomFiles = files.get(roomId);
  const filesObj: Record<string, ExcalidrawFile> = {};
  roomFiles?.forEach((f, id) => { filesObj[id] = f; });
  const initialMessage: InitialElementsMessage & { files?: Record<string, ExcalidrawFile> } = {
    type: 'initial_elements',
    elements: Array.from(roomEl?.values() || []),
    ...(roomFiles && roomFiles.size > 0 ? { files: filesObj } : {})
  };
  ws.send(JSON.stringify(initialMessage));

  const syncMessage: SyncStatusMessage = {
    type: 'sync_status',
    elementCount: roomEl?.size || 0,
    timestamp: new Date().toISOString()
  };
  ws.send(JSON.stringify(syncMessage));

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw.toString()) as WebSocketMessage;
      if (typeof data.clientId === 'string') {
        roomWs.clientId = data.clientId;
      }
      if (typeof data.username === 'string' || data.username === null) {
        roomWs.username = data.username;
      }
      if (data.color && typeof data.color === 'object') {
        roomWs.color = data.color as RoomWebSocket['color'];
      }

      switch (data.type) {
        case 'client_join':
          logger.debug(`WS client joined room ${roomId}: ${roomWs.clientId || 'unknown'}`);
          break;

        case 'pointer_update':
          if (!roomWs.clientId) return;
          broadcast(roomId, {
            type: 'pointer_update',
            clientId: roomWs.clientId,
            username: roomWs.username ?? data.username ?? null,
            color: roomWs.color ?? data.color,
            pointer: data.pointer,
            button: data.button,
            selectedElementIds: data.selectedElementIds,
            timestamp: new Date().toISOString()
          } as PointerUpdateMessage, { exclude: ws });
          break;

        default:
          logger.debug(`Ignoring unsupported client WS message in room ${roomId}: ${data.type}`);
      }
    } catch (error) {
      logger.warn(`Invalid WebSocket message in room ${roomId}:`, error);
    }
  });

  ws.on('close', () => {
    set.delete(ws);
    if (roomWs.clientId) {
      broadcast(roomId, {
        type: 'client_disconnected',
        clientId: roomWs.clientId,
        timestamp: new Date().toISOString()
      } as WebSocketMessage);
    }
    logger.info(`WS disconnected from room ${roomId} (clients: ${set.size})`);
  });

  ws.on('error', (error) => {
    logger.error(`WebSocket error in room ${roomId}:`, error);
    set.delete(ws);
  });
});

function normalizeLineBreakMarkup(text: string): string {
  return text
    .replace(/<\s*b\s*r\s*\/?\s*>/gi, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

// ─── Schema validation (unchanged) ──────────────────────────────
const CreateElementSchema = z.object({
  id: z.string().optional(),
  type: z.enum(Object.values(EXCALIDRAW_ELEMENT_TYPES) as [ExcalidrawElementType, ...ExcalidrawElementType[]]),
  x: z.number(),
  y: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
  backgroundColor: z.string().optional(),
  strokeColor: z.string().optional(),
  strokeWidth: z.number().optional(),
  strokeStyle: z.string().optional(),
  roughness: z.number().optional(),
  opacity: z.number().optional(),
  text: z.string().optional(),
  label: z.object({ text: z.string() }).optional(),
  fontSize: z.number().optional(),
  fontFamily: z.union([z.string(), z.number()]).optional(),
  groupIds: z.array(z.string()).optional(),
  locked: z.boolean().optional(),
  roundness: z.object({ type: z.number(), value: z.number().optional() }).nullable().optional(),
  fillStyle: z.string().optional(),
  points: z.any().optional(),
  start: z.object({ id: z.string() }).optional(),
  end: z.object({ id: z.string() }).optional(),
  startArrowhead: z.string().nullable().optional(),
  endArrowhead: z.string().nullable().optional(),
  elbowed: z.boolean().optional(),
  startBinding: z.object({
    elementId: z.string(),
    focus: z.number().optional(),
    gap: z.number().optional(),
    fixedPoint: z.tuple([z.number(), z.number()]).nullable().optional(),
    mode: z.string().optional(),
  }).nullable().optional(),
  endBinding: z.object({
    elementId: z.string(),
    focus: z.number().optional(),
    gap: z.number().optional(),
    fixedPoint: z.tuple([z.number(), z.number()]).nullable().optional(),
    mode: z.string().optional(),
  }).nullable().optional(),
  boundElements: z.array(z.object({
    id: z.string(),
    type: z.enum(['arrow', 'text']),
  })).nullable().optional(),
  fileId: z.string().optional(),
  status: z.string().optional(),
  scale: z.tuple([z.number(), z.number()]).optional(),
  customData: z.record(z.any()).nullable().optional(),
}).passthrough();

const UpdateElementSchema = z.object({
  id: z.string(),
  type: z.enum(Object.values(EXCALIDRAW_ELEMENT_TYPES) as [ExcalidrawElementType, ...ExcalidrawElementType[]]).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  backgroundColor: z.string().optional(),
  strokeColor: z.string().optional(),
  strokeWidth: z.number().optional(),
  strokeStyle: z.string().optional(),
  roughness: z.number().optional(),
  opacity: z.number().optional(),
  text: z.string().optional(),
  originalText: z.string().optional(),
  label: z.object({ text: z.string() }).optional(),
  fontSize: z.number().optional(),
  fontFamily: z.union([z.string(), z.number()]).optional(),
  groupIds: z.array(z.string()).optional(),
  locked: z.boolean().optional(),
  roundness: z.object({ type: z.number(), value: z.number().optional() }).nullable().optional(),
  fillStyle: z.string().optional(),
  points: z.array(z.union([
    z.tuple([z.number(), z.number()]),
    z.object({ x: z.number(), y: z.number() })
  ])).optional(),
  start: z.object({ id: z.string() }).optional(),
  end: z.object({ id: z.string() }).optional(),
  startArrowhead: z.string().nullable().optional(),
  endArrowhead: z.string().nullable().optional(),
  elbowed: z.boolean().optional(),
  startBinding: z.object({
    elementId: z.string(),
    focus: z.number().optional(),
    gap: z.number().optional(),
    fixedPoint: z.tuple([z.number(), z.number()]).nullable().optional(),
    mode: z.string().optional(),
  }).nullable().optional(),
  endBinding: z.object({
    elementId: z.string(),
    focus: z.number().optional(),
    gap: z.number().optional(),
    fixedPoint: z.tuple([z.number(), z.number()]).nullable().optional(),
    mode: z.string().optional(),
  }).nullable().optional(),
  boundElements: z.array(z.object({
    id: z.string(),
    type: z.enum(['arrow', 'text']),
  })).nullable().optional(),
  fileId: z.string().optional(),
  status: z.string().optional(),
  scale: z.tuple([z.number(), z.number()]).optional(),
  customData: z.record(z.any()).nullable().optional(),
}).passthrough();

// ─── Geometry helpers (unchanged from upstream) ─────────────────
function computeEdgePoint(
  el: ServerElement,
  targetCenterX: number,
  targetCenterY: number
): { x: number; y: number } {
  const cx = el.x + (el.width || 0) / 2;
  const cy = el.y + (el.height || 0) / 2;
  const dx = targetCenterX - cx;
  const dy = targetCenterY - cy;

  if (el.type === 'diamond') {
    const hw = (el.width || 0) / 2;
    const hh = (el.height || 0) / 2;
    if (dx === 0 && dy === 0) return { x: cx, y: cy + hh };
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    const scale = (absDx / hw + absDy / hh) > 0
      ? 1 / (absDx / hw + absDy / hh)
      : 1;
    return { x: cx + dx * scale, y: cy + dy * scale };
  }

  if (el.type === 'ellipse') {
    const a = (el.width || 0) / 2;
    const b = (el.height || 0) / 2;
    if (dx === 0 && dy === 0) return { x: cx, y: cy + b };
    const angle = Math.atan2(dy, dx);
    return { x: cx + a * Math.cos(angle), y: cy + b * Math.sin(angle) };
  }

  const hw = (el.width || 0) / 2;
  const hh = (el.height || 0) / 2;
  if (dx === 0 && dy === 0) return { x: cx, y: cy + hh };
  const angle = Math.atan2(dy, dx);
  const tanA = Math.tan(angle);
  if (Math.abs(tanA * hw) <= hh) {
    const signX = dx >= 0 ? 1 : -1;
    return { x: cx + signX * hw, y: cy + signX * hw * tanA };
  } else {
    const signY = dy >= 0 ? 1 : -1;
    return { x: cx + signY * hh / tanA, y: cy + signY * hh };
  }
}

function resolveArrowBindings(roomId: string, batchElements: ServerElement[]): void {
  const elementMap = new Map<string, ServerElement>();
  batchElements.forEach(el => elementMap.set(el.id, el));

  const roomEl = elements.get(roomId);
  roomEl?.forEach((el, id) => {
    if (!elementMap.has(id)) elementMap.set(id, el);
  });

  for (const el of batchElements) {
    if (el.type !== 'arrow' && el.type !== 'line') continue;
    const startRef = (el as any).start as { id: string } | undefined;
    const endRef = (el as any).end as { id: string } | undefined;

    if (!startRef && !endRef) continue;

    const startEl = startRef ? elementMap.get(startRef.id) : undefined;
    const endEl = endRef ? elementMap.get(endRef.id) : undefined;

    const startCenter = startEl
      ? { x: startEl.x + (startEl.width || 0) / 2, y: startEl.y + (startEl.height || 0) / 2 }
      : { x: el.x, y: el.y };
    const endCenter = endEl
      ? { x: endEl.x + (endEl.width || 0) / 2, y: endEl.y + (endEl.height || 0) / 2 }
      : { x: el.x + 100, y: el.y };

    const GAP = 8;
    const startPt = startEl
      ? computeEdgePoint(startEl, endCenter.x, endCenter.y)
      : startCenter;
    const endPt = endEl
      ? computeEdgePoint(endEl, startCenter.x, startCenter.y)
      : endCenter;

    const startDx = endPt.x - startPt.x;
    const startDy = endPt.y - startPt.y;
    const startDist = Math.sqrt(startDx * startDx + startDy * startDy) || 1;
    const endDx = startPt.x - endPt.x;
    const endDy = startPt.y - endPt.y;
    const endDist = Math.sqrt(endDx * endDx + endDy * endDy) || 1;

    const finalStart = { x: startPt.x + (startDx / startDist) * GAP, y: startPt.y + (startDy / startDist) * GAP };
    const finalEnd = { x: endPt.x + (endDx / endDist) * GAP, y: endPt.y + (endDy / endDist) * GAP };

    el.x = finalStart.x;
    el.y = finalStart.y;
    el.points = [[0, 0], [finalEnd.x - finalStart.x, finalEnd.y - finalStart.y]];
  }
}

// ─── Pending request maps for round-trip ops ────────────────────
interface PendingExport {
  resolve: (data: { format: string; data: string }) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  collectionTimeout: ReturnType<typeof setTimeout> | null;
  bestResult: { format: string; data: string } | null;
}
const pendingExports = new Map<string, PendingExport>();

interface PendingViewport {
  resolve: (data: { success: boolean; message: string }) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}
const pendingViewports = new Map<string, PendingViewport>();

// ─── Per-room API router ────────────────────────────────────────
const roomApi: Router = Router({ mergeParams: true });
roomApi.use(loadRoom);

roomApi.get('/elements', (req, res) => {
  try {
    const roomEl: Map<string, ServerElement> = res.locals.roomEl;
    const arr = Array.from(roomEl.values());
    res.json({ success: true, elements: arr, count: arr.length });
  } catch (error) {
    logger.error('Error fetching elements:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

roomApi.post('/elements', (req, res) => {
  try {
    const roomId: string = res.locals.roomId;
    const roomEl: Map<string, ServerElement> = res.locals.roomEl;
    const params = CreateElementSchema.parse(req.body);
    const id = params.id || generateId();
    const element: ServerElement = {
      id,
      ...params,
      fontFamily: normalizeFontFamily(params.fontFamily),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1
    };
    if (element.type === 'arrow' || element.type === 'line') {
      resolveArrowBindings(roomId, [element]);
    }
    roomEl.set(id, element);
    touchRoom(roomId);
    markDirty(roomId);
    syncDebug('create', {
      roomId,
      element: summarizeServerElement(element),
      afterCount: roomEl.size,
    });
    broadcast(roomId, { type: 'element_created', element } as ElementCreatedMessage);
    res.json({ success: true, element });
  } catch (error) {
    logger.error('Error creating element:', error);
    res.status(400).json({ success: false, error: (error as Error).message });
  }
});

roomApi.put('/elements/:id', (req, res) => {
  try {
    const roomId: string = res.locals.roomId;
    const roomEl: Map<string, ServerElement> = res.locals.roomEl;
    const { id } = req.params;
    const updates = UpdateElementSchema.parse({ id, ...req.body });
    if (!id) return res.status(400).json({ success: false, error: 'Element ID is required' });

    const existing = roomEl.get(id);
    if (!existing) return res.status(404).json({ success: false, error: `Element ${id} not found` });

    const updated: ServerElement = {
      ...existing,
      ...updates,
      fontFamily: updates.fontFamily !== undefined ? normalizeFontFamily(updates.fontFamily) : existing.fontFamily,
      updatedAt: new Date().toISOString(),
      version: (existing.version || 0) + 1
    };

    const hasTextUpdate = Object.prototype.hasOwnProperty.call(req.body, 'text');
    const hasOriginalTextUpdate = Object.prototype.hasOwnProperty.call(req.body, 'originalText');
    if (updated.type === EXCALIDRAW_ELEMENT_TYPES.TEXT && hasTextUpdate && !hasOriginalTextUpdate) {
      const incomingText = updates.text ?? '';
      const existingText = typeof existing.text === 'string' ? existing.text : '';
      const existingOriginalText = typeof existing.originalText === 'string' ? existing.originalText : '';
      const existingOriginalHasBr = /<\s*b\s*r\s*\/?\s*>/i.test(existingOriginalText);
      const normalizedExistingText = normalizeLineBreakMarkup(existingText);
      const normalizedExistingOriginalText = normalizeLineBreakMarkup(existingOriginalText);
      if (existingOriginalHasBr && incomingText === normalizedExistingText && normalizedExistingOriginalText) {
        updated.text = normalizedExistingOriginalText;
        updated.originalText = normalizedExistingOriginalText;
      } else {
        updated.originalText = incomingText;
      }
    }

    roomEl.set(id, updated);
    touchRoom(roomId);
    markDirty(roomId);
    syncDebug('update', {
      roomId,
      id,
      before: summarizeServerElement(existing),
      after: summarizeServerElement(updated),
      afterCount: roomEl.size,
    });
    broadcast(roomId, { type: 'element_updated', element: updated } as ElementUpdatedMessage);
    res.json({ success: true, element: updated });
  } catch (error) {
    logger.error('Error updating element:', error);
    res.status(400).json({ success: false, error: (error as Error).message });
  }
});

roomApi.delete('/elements/clear', (req, res) => {
  try {
    const roomId: string = res.locals.roomId;
    const roomEl: Map<string, ServerElement> = res.locals.roomEl;
    const count = roomEl.size;
    roomEl.forEach((element, id) => rememberDeletedElement(roomId, element, id));
    roomEl.clear();
    touchRoom(roomId);
    markDirty(roomId);
    syncDebug('clear', {
      roomId,
      count,
      afterCount: roomEl.size,
    });
    broadcast(roomId, { type: 'canvas_cleared', timestamp: new Date().toISOString() });
    res.json({ success: true, message: `Cleared ${count} elements`, count });
  } catch (error) {
    logger.error('Error clearing canvas:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

roomApi.delete('/elements/:id', (req, res) => {
  try {
    const roomId: string = res.locals.roomId;
    const roomEl: Map<string, ServerElement> = res.locals.roomEl;
    const { id } = req.params;
    if (!id) return res.status(400).json({ success: false, error: 'Element ID is required' });
    const existing = roomEl.get(id);
    if (!existing) return res.status(404).json({ success: false, error: `Element ${id} not found` });
    rememberDeletedElement(roomId, existing, id);
    roomEl.delete(id);
    touchRoom(roomId);
    markDirty(roomId);
    syncDebug('delete', {
      roomId,
      id,
      deleted: summarizeServerElement(existing),
      afterCount: roomEl.size,
    });
    broadcast(roomId, { type: 'element_deleted', elementId: id } as ElementDeletedMessage);
    res.json({ success: true, message: `Element ${id} deleted successfully` });
  } catch (error) {
    logger.error('Error deleting element:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

roomApi.get('/elements/search', (req, res) => {
  try {
    const roomEl: Map<string, ServerElement> = res.locals.roomEl;
    const { type, x_min, x_max, y_min, y_max, ...filters } = req.query;
    let results = Array.from(roomEl.values());
    if (type && typeof type === 'string') results = results.filter(el => el.type === type);
    if (x_min !== undefined || x_max !== undefined || y_min !== undefined || y_max !== undefined) {
      const xMin = x_min !== undefined ? Number(x_min) : -Infinity;
      const xMax = x_max !== undefined ? Number(x_max) : Infinity;
      const yMin = y_min !== undefined ? Number(y_min) : -Infinity;
      const yMax = y_max !== undefined ? Number(y_max) : Infinity;
      results = results.filter(el => el.x >= xMin && el.x <= xMax && el.y >= yMin && el.y <= yMax);
    }
    if (Object.keys(filters).length > 0) {
      results = results.filter(el =>
        Object.entries(filters).every(([k, v]) => (el as any)[k] === v)
      );
    }
    res.json({ success: true, elements: results, count: results.length });
  } catch (error) {
    logger.error('Error querying elements:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

roomApi.get('/elements/:id', (req, res) => {
  try {
    const roomEl: Map<string, ServerElement> = res.locals.roomEl;
    const { id } = req.params;
    if (!id) return res.status(400).json({ success: false, error: 'Element ID is required' });
    const el = roomEl.get(id);
    if (!el) return res.status(404).json({ success: false, error: `Element ${id} not found` });
    res.json({ success: true, element: el });
  } catch (error) {
    logger.error('Error fetching element:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

roomApi.post('/elements/batch', (req, res) => {
  try {
    const roomId: string = res.locals.roomId;
    const roomEl: Map<string, ServerElement> = res.locals.roomEl;
    const { elements: elementsToCreate } = req.body;
    if (!Array.isArray(elementsToCreate)) {
      return res.status(400).json({ success: false, error: 'Expected an array of elements' });
    }
    const created: ServerElement[] = [];
    elementsToCreate.forEach(elementData => {
      const params = CreateElementSchema.parse(elementData);
      const id = params.id || generateId();
      const element: ServerElement = {
        id,
        ...params,
        fontFamily: normalizeFontFamily(params.fontFamily),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1
      };
      created.push(element);
    });
    resolveArrowBindings(roomId, created);
    created.forEach(el => roomEl.set(el.id, el));
    touchRoom(roomId);
    markDirty(roomId);
    syncDebug('batch-create', {
      roomId,
      count: created.length,
      afterCount: roomEl.size,
      sample: created.slice(0, 5).map(summarizeServerElement),
    });
    broadcast(roomId, { type: 'elements_batch_created', elements: created } as BatchCreatedMessage);
    res.json({ success: true, elements: created, count: created.length });
  } catch (error) {
    logger.error('Error batch creating elements:', error);
    res.status(400).json({ success: false, error: (error as Error).message });
  }
});

roomApi.post('/elements/from-mermaid', (req, res) => {
  try {
    const roomId: string = res.locals.roomId;
    const { mermaidDiagram, config } = req.body;
    if (!mermaidDiagram || typeof mermaidDiagram !== 'string') {
      return res.status(400).json({ success: false, error: 'Mermaid diagram definition is required' });
    }
    broadcast(roomId, { type: 'mermaid_convert', mermaidDiagram, config: config || {}, timestamp: new Date().toISOString() });
    res.json({ success: true, mermaidDiagram, config: config || {}, message: 'Mermaid diagram sent to frontend for conversion.' });
  } catch (error) {
    logger.error('Error processing Mermaid diagram:', error);
    res.status(400).json({ success: false, error: (error as Error).message });
  }
});

roomApi.post('/elements/patch', (req, res) => {
  try {
    const roomId: string = res.locals.roomId;
    const roomEl: Map<string, ServerElement> = res.locals.roomEl;
    const { elements: frontendElements = [], deletedElementIds = [], timestamp, clientId, traceId } = req.body;

    if (!Array.isArray(frontendElements)) {
      return res.status(400).json({ success: false, error: 'Expected elements to be an array' });
    }
    if (!Array.isArray(deletedElementIds)) {
      return res.status(400).json({ success: false, error: 'Expected deletedElementIds to be an array' });
    }

    let successCount = 0;
    let deletedCount = 0;
    let staleCount = 0;
    let tombstoneRejectedCount = 0;
    const processed: ServerElement[] = [];
    const staleSamples: Record<string, unknown>[] = [];
    const tombstoneRejectedSamples: Record<string, unknown>[] = [];

    frontendElements.forEach((element: any, index: number) => {
      try {
        const elementId = element.id || generateId();
        const processedElement: ServerElement = {
          ...element,
          id: elementId,
          syncedAt: new Date().toISOString(),
          source: 'frontend_patch',
          syncTimestamp: timestamp,
          version: typeof element.version === 'number' && Number.isFinite(element.version) ? element.version : 1
        };
        if (isTombstonedStaleElement(roomId, processedElement)) {
          tombstoneRejectedCount++;
          if (tombstoneRejectedSamples.length < 5) {
            tombstoneRejectedSamples.push({
              incoming: summarizeServerElement(processedElement),
              tombstone: getRoomTombstones(roomId).get(elementId),
            });
          }
          return;
        }
        const existingElement = roomEl.get(elementId);
        if (!shouldAcceptIncomingElement(existingElement, processedElement)) {
          staleCount++;
          if (staleSamples.length < 5) {
            staleSamples.push({
              incoming: summarizeServerElement(processedElement),
              existing: summarizeServerElement(existingElement),
            });
          }
          return;
        }
        roomEl.set(elementId, processedElement);
        processed.push(processedElement);
        successCount++;
      } catch (elementError) {
        logger.warn(`Failed to patch element ${index}:`, elementError);
      }
    });

    const normalizedDeletedIds = deletedElementIds
      .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0);
    normalizedDeletedIds.forEach((id) => {
      rememberDeletedElement(roomId, roomEl.get(id), id);
      if (roomEl.delete(id)) deletedCount++;
    });
    syncDebug('patch', {
      roomId,
      clientId,
      traceId,
      incomingCount: frontendElements.length,
      successCount,
      deletedCount,
      staleCount,
      tombstoneRejectedCount,
      afterCount: roomEl.size,
      sample: processed.slice(0, 5).map(element => ({
        id: element.id,
        type: element.type,
        x: element.x,
        y: element.y,
        version: element.version,
        updated: element.updated,
      })),
      staleSamples,
      tombstoneRejectedSamples,
      deletedElementIds: normalizedDeletedIds.slice(0, 20),
    });

    if (successCount > 0 || deletedCount > 0) {
      touchRoom(roomId);
      markDirty(roomId);
    }

    broadcast(roomId, {
      type: 'elements_patched',
      elements: processed,
      deletedElementIds: normalizedDeletedIds,
      count: successCount,
      deletedCount,
      timestamp: new Date().toISOString(),
      source: 'frontend_patch',
      clientId,
      traceId
    } as ElementsPatchedMessage, { excludeClientId: typeof clientId === 'string' ? clientId : undefined });

    res.json({
      success: true,
      message: `Patched ${successCount} element(s), deleted ${deletedCount}`,
      count: successCount,
      deletedCount,
      staleCount,
      tombstoneRejectedCount,
      deletedElementIds: normalizedDeletedIds,
      elements: processed,
      syncedAt: new Date().toISOString(),
      afterCount: roomEl.size
    });
  } catch (error) {
    logger.error('Patch sync error:', error);
    res.status(500).json({ success: false, error: (error as Error).message, details: 'Internal server error during patch sync operation' });
  }
});

roomApi.post('/elements/sync', (req, res) => {
  try {
    const roomId: string = res.locals.roomId;
    const roomEl: Map<string, ServerElement> = res.locals.roomEl;
    const { elements: frontendElements, timestamp, clientId, traceId } = req.body;
    const replace = req.body.replace !== false;
    if (!Array.isArray(frontendElements)) {
      return res.status(400).json({ success: false, error: 'Expected elements to be an array' });
    }
    const beforeCount = roomEl.size;
    const incomingIds = new Set<string>();
    frontendElements.forEach((element: any) => {
      if (typeof element?.id === 'string' && element.id.length > 0) incomingIds.add(element.id);
    });
    if (replace) {
      roomEl.forEach((element, id) => {
        if (!incomingIds.has(id)) rememberDeletedElement(roomId, element, id);
      });
      const tombstones = getRoomTombstones(roomId);
      incomingIds.forEach(id => tombstones.delete(id));
      roomEl.clear();
    }
    let successCount = 0;
    let staleCount = 0;
    let tombstoneRejectedCount = 0;
    const processed: ServerElement[] = [];
    const staleSamples: Record<string, unknown>[] = [];
    const tombstoneRejectedSamples: Record<string, unknown>[] = [];
    frontendElements.forEach((element: any, index: number) => {
      try {
        const elementId = element.id || generateId();
        const processedElement: ServerElement = {
          ...element,
          id: elementId,
          syncedAt: new Date().toISOString(),
          source: 'frontend_sync',
          syncTimestamp: timestamp,
          version: typeof element.version === 'number' && Number.isFinite(element.version) ? element.version : 1
        };
        if (isTombstonedStaleElement(roomId, processedElement)) {
          tombstoneRejectedCount++;
          if (tombstoneRejectedSamples.length < 5) {
            tombstoneRejectedSamples.push({
              incoming: summarizeServerElement(processedElement),
              tombstone: getRoomTombstones(roomId).get(elementId),
            });
          }
          return;
        }
        const existingElement = roomEl.get(elementId);
        if (!shouldAcceptIncomingElement(existingElement, processedElement)) {
          staleCount++;
          if (staleSamples.length < 5) {
            staleSamples.push({
              incoming: summarizeServerElement(processedElement),
              existing: summarizeServerElement(existingElement),
            });
          }
          return;
        }
        roomEl.set(elementId, processedElement);
        processed.push(processedElement);
        successCount++;
      } catch (elementError) {
        logger.warn(`Failed to process element ${index}:`, elementError);
      }
    });
    syncDebug('sync', {
      roomId,
      clientId,
      traceId,
      replace,
      incomingCount: frontendElements.length,
      successCount,
      staleCount,
      tombstoneRejectedCount,
      beforeCount,
      afterCount: roomEl.size,
      sample: processed.slice(0, 5).map(element => ({
        id: element.id,
        type: element.type,
        x: element.x,
        y: element.y,
        version: element.version,
        updated: element.updated,
      })),
      staleSamples,
      tombstoneRejectedSamples,
    });
    touchRoom(roomId);
    markDirty(roomId);
    broadcast(roomId, {
      type: 'elements_synced',
      elements: processed,
      count: successCount,
      timestamp: new Date().toISOString(),
      source: 'frontend_sync',
      clientId,
      traceId
    }, { excludeClientId: typeof clientId === 'string' ? clientId : undefined });
    res.json({
      success: true,
      message: `Successfully synced ${successCount} elements`,
      count: successCount,
      staleCount,
      tombstoneRejectedCount,
      syncedAt: new Date().toISOString(),
      beforeCount,
      afterCount: roomEl.size
    });
  } catch (error) {
    logger.error('Sync error:', error);
    res.status(500).json({ success: false, error: (error as Error).message, details: 'Internal server error during sync operation' });
  }
});

// ─── Files (per-room) ───────────────────────────────────────────
roomApi.get('/files', (_req, res) => {
  const roomFiles: Map<string, ExcalidrawFile> = res.locals.roomFiles;
  const filesObj: Record<string, ExcalidrawFile> = {};
  roomFiles.forEach((f, id) => { filesObj[id] = f; });
  res.json({ files: filesObj });
});

roomApi.post('/files', (req, res) => {
  const roomId: string = res.locals.roomId;
  const roomFiles: Map<string, ExcalidrawFile> = res.locals.roomFiles;
  const body = req.body;
  const fileList: ExcalidrawFile[] = Array.isArray(body) ? body : (body?.files || []);
  for (const f of fileList) {
    if (f.id && f.dataURL) {
      roomFiles.set(f.id, { id: f.id, dataURL: f.dataURL, mimeType: f.mimeType || 'image/png', created: f.created || Date.now() });
    }
  }
  touchRoom(roomId);
  markDirty(roomId);
  broadcast(roomId, { type: 'files_added', files: fileList });
  res.json({ success: true, count: fileList.length });
});

roomApi.delete('/files/:id', (req, res) => {
  const roomId: string = res.locals.roomId;
  const roomFiles: Map<string, ExcalidrawFile> = res.locals.roomFiles;
  const id = req.params.id as string;
  if (roomFiles.delete(id)) {
    touchRoom(roomId);
    markDirty(roomId);
    broadcast(roomId, { type: 'file_deleted', fileId: id });
    res.json({ success: true });
  } else {
    res.status(404).json({ success: false, error: `File with ID ${id} not found` });
  }
});

// ─── Image export round-trip ────────────────────────────────────
roomApi.post('/export/image', (req, res) => {
  try {
    const roomId: string = res.locals.roomId;
    const roomEl: Map<string, ServerElement> = res.locals.roomEl;
    const roomFiles: Map<string, ExcalidrawFile> = res.locals.roomFiles;
    const { format, background } = req.body;
    if (!format || !['png', 'svg'].includes(format)) {
      return res.status(400).json({ success: false, error: 'format must be "png" or "svg"' });
    }
    const set = getRoomClients(roomId);
    if (set.size === 0) {
      return res.status(503).json({ success: false, error: 'No frontend client connected for this room. Open the canvas in a browser first.' });
    }
    const requestId = generateId();
    const exportPromise = new Promise<{ format: string; data: string }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = pendingExports.get(requestId);
        pendingExports.delete(requestId);
        if (pending?.bestResult) resolve(pending.bestResult);
        else reject(new Error('Export timed out after 30 seconds'));
      }, 30000);
      pendingExports.set(requestId, { resolve, reject, timeout, collectionTimeout: null, bestResult: null });
    });

    const filesObj: Record<string, ExcalidrawFile> = {};
    roomFiles.forEach((f, id) => { filesObj[id] = f; });
    broadcast(roomId, {
      type: 'initial_elements',
      elements: Array.from(roomEl.values()),
      ...(roomFiles.size > 0 ? { files: filesObj } : {})
    } as InitialElementsMessage & { files?: Record<string, ExcalidrawFile> });

    setTimeout(() => {
      broadcast(roomId, { type: 'export_image_request', requestId, format, background: background ?? true });
    }, 800);

    exportPromise
      .then(result => res.json({ success: true, format: result.format, data: result.data }))
      .catch(error => res.status(500).json({ success: false, error: (error as Error).message }));
  } catch (error) {
    logger.error('Error initiating image export:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

roomApi.post('/export/image/result', (req, res) => {
  try {
    const { requestId, format, data, error } = req.body;
    if (!requestId) return res.status(400).json({ success: false, error: 'requestId is required' });
    const pending = pendingExports.get(requestId);
    if (!pending) return res.json({ success: true });
    if (error) {
      logger.warn(`Export error from one client (requestId=${requestId}): ${error}`);
      return res.json({ success: true });
    }
    if (!pending.bestResult || data.length > pending.bestResult.data.length) {
      pending.bestResult = { format, data };
    }
    if (!pending.collectionTimeout) {
      pending.collectionTimeout = setTimeout(() => {
        const p = pendingExports.get(requestId);
        if (p?.bestResult) {
          clearTimeout(p.timeout);
          pendingExports.delete(requestId);
          p.resolve(p.bestResult);
        }
      }, 3000);
    }
    res.json({ success: true });
  } catch (error) {
    logger.error('Error processing export result:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// ─── Viewport round-trip ────────────────────────────────────────
roomApi.post('/viewport', (req, res) => {
  try {
    const roomId: string = res.locals.roomId;
    const { scrollToContent, scrollToElementId, zoom, offsetX, offsetY } = req.body;
    if (getRoomClients(roomId).size === 0) {
      return res.status(503).json({ success: false, error: 'No frontend client connected for this room. Open the canvas in a browser first.' });
    }
    const requestId = generateId();
    const viewportPromise = new Promise<{ success: boolean; message: string }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingViewports.delete(requestId);
        reject(new Error('Viewport request timed out after 10 seconds'));
      }, 10000);
      pendingViewports.set(requestId, { resolve, reject, timeout });
    });
    broadcast(roomId, { type: 'set_viewport', requestId, scrollToContent, scrollToElementId, zoom, offsetX, offsetY });
    viewportPromise
      .then(result => res.json(result))
      .catch(error => res.status(500).json({ success: false, error: (error as Error).message }));
  } catch (error) {
    logger.error('Error initiating viewport change:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

roomApi.post('/viewport/result', (req, res) => {
  try {
    const { requestId, message, error } = req.body;
    if (!requestId) return res.status(400).json({ success: false, error: 'requestId is required' });
    const pending = pendingViewports.get(requestId);
    if (!pending) return res.json({ success: true });
    if (error) {
      clearTimeout(pending.timeout);
      pendingViewports.delete(requestId);
      pending.resolve({ success: false, message: error });
      return res.json({ success: true });
    }
    clearTimeout(pending.timeout);
    pendingViewports.delete(requestId);
    pending.resolve({ success: true, message: message || 'Viewport updated' });
    res.json({ success: true });
  } catch (error) {
    logger.error('Error processing viewport result:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// ─── Snapshots (per-room) ───────────────────────────────────────
roomApi.post('/snapshots', (req, res) => {
  try {
    const roomId: string = res.locals.roomId;
    const roomEl: Map<string, ServerElement> = res.locals.roomEl;
    const roomSnaps: Map<string, Snapshot> = res.locals.roomSnaps;
    const { name } = req.body;
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ success: false, error: 'Snapshot name is required' });
    }
    const snapshot: Snapshot = {
      name,
      elements: Array.from(roomEl.values()),
      createdAt: new Date().toISOString()
    };
    roomSnaps.set(name, snapshot);
    touchRoom(roomId);
    markDirty(roomId);
    res.json({ success: true, name, elementCount: snapshot.elements.length, createdAt: snapshot.createdAt });
  } catch (error) {
    logger.error('Error saving snapshot:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

roomApi.get('/snapshots', (_req, res) => {
  try {
    const roomSnaps: Map<string, Snapshot> = res.locals.roomSnaps;
    const list = Array.from(roomSnaps.values()).map(s => ({
      name: s.name, elementCount: s.elements.length, createdAt: s.createdAt
    }));
    res.json({ success: true, snapshots: list, count: list.length });
  } catch (error) {
    logger.error('Error listing snapshots:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

roomApi.get('/snapshots/:name', (req, res) => {
  try {
    const roomSnaps: Map<string, Snapshot> = res.locals.roomSnaps;
    const { name } = req.params;
    const snapshot = roomSnaps.get(name!);
    if (!snapshot) return res.status(404).json({ success: false, error: `Snapshot "${name}" not found` });
    res.json({ success: true, snapshot });
  } catch (error) {
    logger.error('Error fetching snapshot:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

roomApi.get('/sync/status', (_req, res) => {
  const roomId: string = res.locals.roomId;
  const roomEl: Map<string, ServerElement> = res.locals.roomEl;
  res.json({
    success: true,
    roomId,
    elementCount: roomEl.size,
    timestamp: new Date().toISOString(),
    websocketClients: getRoomClients(roomId).size
  });
});

app.use('/api/r/:roomId', roomApi);

// ─── Admin API ──────────────────────────────────────────────────
const adminApi: Router = Router();
adminApi.use(requireAdmin);

adminApi.get('/rooms', (_req, res) => {
  const list = Array.from(roomsMeta.values()).map(meta => ({
    ...meta,
    elementCount: elements.get(meta.id)?.size || 0,
    shareUrl: shareUrlFor(meta.id)
  }));
  res.json({ success: true, rooms: list });
});

adminApi.post('/rooms', (req, res) => {
  const { name, id: providedId } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ success: false, error: 'name is required' });
  }
  let id = (typeof providedId === 'string' && /^[A-Za-z0-9_-]{4,32}$/.test(providedId)) ? providedId : newRoomId();
  if (roomExists(id)) id = newRoomId();
  const meta = ensureRoom(id, name.trim());
  markDirty(id);
  res.json({ success: true, room: { ...meta, shareUrl: shareUrlFor(id), elementCount: 0 } });
});

adminApi.patch('/rooms/:roomId', (req, res) => {
  const { roomId } = req.params;
  if (!roomId || !roomExists(roomId)) {
    return res.status(404).json({ success: false, error: `Room ${roomId} not found` });
  }
  const meta = roomsMeta.get(roomId)!;
  const { name } = req.body || {};
  if (typeof name === 'string' && name.trim()) {
    meta.name = name.trim();
    meta.updatedAt = new Date().toISOString();
    markDirty(roomId);
  }
  res.json({ success: true, room: { ...meta, shareUrl: shareUrlFor(roomId), elementCount: elements.get(roomId)?.size || 0 } });
});

adminApi.delete('/rooms/:roomId', (req, res) => {
  const { roomId } = req.params;
  if (!roomId || !roomExists(roomId)) {
    return res.status(404).json({ success: false, error: `Room ${roomId} not found` });
  }
  // Disconnect any open WS clients so they don't keep ghosts around
  const set = clientsByRoom.get(roomId);
  if (set) {
    set.forEach(ws => { try { ws.close(1000, 'Room deleted'); } catch {} });
    clientsByRoom.delete(roomId);
  }
  deleteRoom(roomId);
  deleteRoomFile(roomId);
  res.json({ success: true });
});

app.use('/api/admin', adminApi);

// ─── SPA serving ────────────────────────────────────────────────
// Bare root → optional redirect to the dashboard (tailnet only) when ROOT_REDIRECT_URL is set,
// otherwise 404 (boards are share-link-only).
app.get('/', (_req, res) => {
  if (ROOT_REDIRECT_URL) {
    res.redirect(302, ROOT_REDIRECT_URL);
    return;
  }
  res.status(404).type('text/plain').send('Not found.\n');
});

// Cached SPA HTML — read once at first request, then patched per-room with OG tags.
import fsSync from 'fs';
let cachedHtml: string | null = null;
function getSpaHtml(): string {
  if (!cachedHtml) {
    const htmlFile = path.join(__dirname, '../dist/frontend/index.html');
    cachedHtml = fsSync.readFileSync(htmlFile, 'utf-8');
  }
  return cachedHtml;
}
function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function renderRoomHtml(roomId: string, roomName: string): string {
  const safeName = htmlEscape(roomName || 'Untitled board');
  const title = `${safeName} · Excalidraw / Zephy`;
  const url = PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/r/${roomId}` : `/r/${roomId}`;
  const image = (PUBLIC_BASE_URL || '') + '/og-image.png';
  const ogTags = [
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="A self-hosted collaborative drawing canvas. Open the link to draw alongside.">`,
    `<meta property="og:url" content="${htmlEscape(url)}">`,
    `<meta property="og:image" content="${htmlEscape(image)}">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta property="og:site_name" content="Excalidraw / Zephy">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${title}">`,
    `<meta name="twitter:description" content="A self-hosted collaborative drawing canvas.">`,
    `<meta name="twitter:image" content="${htmlEscape(image)}">`,
    `<meta name="description" content="${title} — a self-hosted collaborative Excalidraw board.">`,
  ].join('\n    ');
  return getSpaHtml()
    .replace('<title>Excalidraw / Zephy</title>', `<title>${title}</title>`)
    .replace('<!-- OG_TAGS_PLACEHOLDER -->', ogTags);
}

// Per-room SPA: any path under /r/:roomId/ that doesn't match an asset returns the SPA HTML
app.get(['/r/:roomId', '/r/:roomId/*'], (req, res) => {
  const roomId = req.params.roomId;
  if (!roomId || !roomExists(roomId)) {
    return res.status(404).type('text/plain').send('Board not found.\n');
  }
  try {
    const meta = roomsMeta.get(roomId);
    res.type('text/html').send(renderRoomHtml(roomId, meta?.name || ''));
  } catch (err) {
    logger.error('Error serving frontend:', err);
    res.status(500).send('Frontend not built. Please run "npm run build" first.');
  }
});

app.get('/health', (_req, res) => {
  let total = 0;
  elements.forEach(map => { total += map.size; });
  let totalClients = 0;
  clientsByRoom.forEach(set => { totalClients += set.size; });
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    rooms: roomsMeta.size,
    total_elements: total,
    websocket_clients: totalClients
  });
});

app.use((err: Error & { status?: number; statusCode?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
  // Pass through body-parser / framework 4xx errors with their original status + message
  // instead of clobbering with a generic 500 (e.g. JSON parse failures, payload-too-large).
  const isClientError = (err.statusCode && err.statusCode < 500) || (err.status && err.status < 500);
  if (isClientError) {
    res.status(err.statusCode || err.status || 400).json({ success: false, error: err.message });
    return;
  }
  logger.error('Unhandled error:', err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// ─── Startup ────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '127.0.0.1';
const LOOPBACK_GUARD_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '::']);
const LOOPBACK_ADDRESSES = ['127.0.0.1', '::1'];

function formatHostForUrl(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const socket = net.createConnection({ host, port });
    const finish = (isOpen: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(isOpen);
    };
    socket.setTimeout(250);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function findExistingLoopbackListener(port: number): Promise<string | null> {
  for (const host of LOOPBACK_ADDRESSES) {
    if (await canConnect(host, port)) return host;
  }
  return null;
}

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    const address = (error as NodeJS.ErrnoException & { address?: string }).address || HOST;
    logger.error(`Canvas server port ${PORT} is already in use on ${formatHostForUrl(address)}.`);
  } else if (error.code === 'EACCES') {
    logger.error(`Canvas server cannot bind ${formatHostForUrl(HOST)}:${PORT}: permission denied.`);
  } else {
    logger.error('Failed to start canvas server:', error);
  }
  process.exit(1);
});

// ─── Auto-snapshot loop ─────────────────────────────────────────
// Periodically saves a snapshot of every room that has changed since the previous
// auto-snapshot, named `auto-<isoTimestamp>`. Keeps the N newest auto-* snapshots
// per room, prunes the rest. Manual snapshots (any non-`auto-` name) are untouched.
function takeAutoSnapshots(): void {
  const isoNow = new Date().toISOString();
  let snapped = 0;
  let skipped = 0;
  for (const [roomId, meta] of roomsMeta.entries()) {
    const roomEl = elements.get(roomId);
    const roomSnaps = snapshots.get(roomId);
    if (!roomEl || !roomSnaps) continue;

    // Skip if room hasn't been touched since our latest auto-snapshot
    let latestAuto = '';
    for (const [name, snap] of roomSnaps.entries()) {
      if (name.startsWith('auto-') && snap.createdAt > latestAuto) {
        latestAuto = snap.createdAt;
      }
    }
    if (latestAuto && meta.updatedAt <= latestAuto) {
      skipped++;
      continue;
    }

    const name = `auto-${isoNow}`;
    roomSnaps.set(name, {
      name,
      elements: Array.from(roomEl.values()),
      createdAt: isoNow,
    });

    // Prune older auto-* (ISO timestamps sort chronologically)
    const autoNames = Array.from(roomSnaps.keys())
      .filter(n => n.startsWith('auto-'))
      .sort();
    const excess = autoNames.length - AUTO_SNAPSHOT_KEEP;
    for (let i = 0; i < excess; i++) {
      const oldName = autoNames[i];
      if (oldName) roomSnaps.delete(oldName);
    }

    markDirty(roomId);
    snapped++;
  }
  if (snapped + skipped > 0) {
    logger.info(`Auto-snapshot: snapped=${snapped} skipped=${skipped} (interval=${AUTO_SNAPSHOT_INTERVAL_MS}ms, keep=${AUTO_SNAPSHOT_KEEP})`);
  }
}

async function startServer(): Promise<void> {
  // Loopback collision check skipped when binding non-loopback (e.g. 0.0.0.0 in production
  // behind cloudflared) to avoid false positives.
  if (LOOPBACK_GUARD_HOSTS.has(HOST) && !ADMIN_API_KEY) {
    const existingHost = await findExistingLoopbackListener(PORT);
    if (existingHost) {
      logger.error(
        `Refusing to start canvas server on ${formatHostForUrl(HOST)}:${PORT}: ` +
        `${formatHostForUrl(existingHost)}:${PORT} is already listening. ` +
        'This prevents duplicate IPv4/IPv6 canvas servers from splitting state.'
      );
      process.exit(1);
    }
  }

  loadAll();

  // Start auto-snapshot loop (don't keep the event loop alive solely for this).
  if (AUTO_SNAPSHOT_INTERVAL_MS > 0) {
    const snapTimer = setInterval(takeAutoSnapshots, AUTO_SNAPSHOT_INTERVAL_MS);
    if (typeof snapTimer.unref === 'function') snapTimer.unref();
  }

  const shutdown = (signal: string): void => {
    logger.info(`Received ${signal}, flushing rooms...`);
    flushAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  server.listen(PORT, HOST, () => {
    const hostForUrl = formatHostForUrl(HOST);
    logger.info(`Canvas server running on http://${hostForUrl}:${PORT}`);
    logger.info(`WebSocket server accepting upgrades on ws://${hostForUrl}:${PORT}/ws/r/:roomId`);
    if (!ADMIN_API_KEY) {
      logger.warn('ADMIN_API_KEY is empty — /api/admin/* will reject all requests until set.');
    }
  });
}

void startServer();

export default app;
