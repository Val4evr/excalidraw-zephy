#!/usr/bin/env node

// Disable colors to prevent ANSI color codes from breaking JSON parsing
process.env.NODE_DISABLE_COLORS = '1';
process.env.NO_COLOR = '1';

import { fileURLToPath } from "url";
import { deflateSync } from 'zlib';
import { webcrypto } from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { 
  CallToolRequestSchema, 
  ListToolsRequestSchema,
  CallToolRequest,
  Tool
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { AsyncLocalStorage } from 'async_hooks';
import logger from './utils/logger.js';
import {
  generateId,
  EXCALIDRAW_ELEMENT_TYPES,
  ServerElement,
  ExcalidrawElementType,
  validateElement,
  normalizeFontFamily
} from './types.js';
import {
  buildSceneDescription,
  SCENE_DESCRIPTION_DETAILS,
  type SceneDescriptionDetail,
} from './sceneDescription.js';
import fetch from 'node-fetch';
import WebSocket from 'ws';

// Load environment variables
dotenv.config();

// Safe file path validation to prevent path traversal attacks
const ALLOWED_EXPORT_DIR = process.env.EXCALIDRAW_EXPORT_DIR || process.cwd();

function sanitizeFilePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  const allowedDir = path.resolve(ALLOWED_EXPORT_DIR);
  if (!resolved.startsWith(allowedDir + path.sep) && resolved !== allowedDir) {
    throw new Error(
      `Path traversal blocked: "${filePath}" resolves outside the allowed directory "${allowedDir}". ` +
      `Set EXCALIDRAW_EXPORT_DIR to change the allowed base directory.`
    );
  }
  return resolved;
}

// Express server configuration. The room is ALWAYS set at runtime via the
// set_room tool with a pasted room URL — there is no ROOM_ID env var, no
// startup default, no fallback. EXPRESS_SERVER_URL only matters when a
// caller passes set_room a bare roomId (no full URL); otherwise the server
// origin is parsed from the roomUrl itself.
const EXPRESS_SERVER_URL = (process.env.EXPRESS_SERVER_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
// When the HTTP MCP server is co-located with canvas (inside the same container),
// fetches to the public URL would bounce out through CF Tunnel and back. Setting
// INTERNAL_CANVAS_URL=http://localhost:3000 short-circuits the round-trip: any
// outbound fetch whose origin matches PUBLIC_BASE_URL is rewritten to the
// internal one. Stdio-shim deployments (where the shim runs on a user's laptop)
// leave this unset, so fetches keep using the public URL — that's the correct
// path for off-host clients.
const INTERNAL_CANVAS_URL = (process.env.INTERNAL_CANVAS_URL || '').replace(/\/$/, '');
const PUBLIC_BASE_URL_FOR_REWRITE = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
function rewriteForInternal(url: string): string {
  if (!INTERNAL_CANVAS_URL || !PUBLIC_BASE_URL_FOR_REWRITE) return url;
  if (url.startsWith(PUBLIC_BASE_URL_FOR_REWRITE)) {
    return INTERNAL_CANVAS_URL + url.slice(PUBLIC_BASE_URL_FOR_REWRITE.length);
  }
  return url;
}
// ROOM_ID env var was removed — set_room is the only way to select a room.
// If you find ROOM_ID set in your client's MCP config, delete it; the shim
// ignores it.
const ENABLE_CANVAS_SYNC = process.env.ENABLE_CANVAS_SYNC !== 'false'; // Default to true
const ENABLE_AGENT_CURSOR = ENABLE_CANVAS_SYNC && process.env.MCP_AGENT_CURSOR !== 'false';
const MCP_CLIENT_ID = `mcp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

type RoomContext = {
  serverUrl: string;
  roomId: string;
  apiBase: string;
  roomUrl: string;
};

const roomContextStorage = new AsyncLocalStorage<RoomContext>();

// Per-session sticky state. Stdio mode runs the whole event loop inside one
// session; the HTTP/MCP endpoint creates a fresh state object per connector
// session and runs each handleRequest inside its own session scope. Tool
// handlers always read/write through this storage so the two modes share
// implementation without leaking state between concurrent sessions.
type McpSessionState = { currentRoom: RoomContext | null };
export const mcpSessionStorage = new AsyncLocalStorage<McpSessionState>();
function currentSession(): McpSessionState {
  let store = mcpSessionStorage.getStore();
  if (!store) {
    // Late-bound default for code paths that run before runServer wraps the
    // event loop (e.g. eager imports). Subsequent reads share this object so
    // set_room still persists across calls.
    store = { currentRoom: null };
    mcpSessionStorage.enterWith(store);
  }
  return store;
}

function normalizeServerUrl(serverUrl: string): string {
  return serverUrl.replace(/\/$/, '');
}

function contextFromServerAndRoom(serverUrl: string, roomId: string): RoomContext {
  const normalizedServerUrl = normalizeServerUrl(serverUrl);
  return {
    serverUrl: normalizedServerUrl,
    roomId,
    apiBase: `${normalizedServerUrl}/api/r/${roomId}`,
    roomUrl: `${normalizedServerUrl}/r/${roomId}`
  };
}

function parseRoomUrl(roomUrl: string): RoomContext {
  const url = new URL(roomUrl);
  const roomMatch = url.pathname.match(/\/r\/([^/?#]+)/) || url.pathname.match(/\/api\/r\/([^/?#]+)/);
  if (!roomMatch?.[1]) {
    throw new Error(`Could not find a room id in roomUrl: ${roomUrl}`);
  }
  return contextFromServerAndRoom(url.origin, decodeURIComponent(roomMatch[1]));
}

function readRoomTarget(args: unknown): { roomId?: string; roomUrl?: string } {
  if (!args || typeof args !== 'object') return {};
  const record = args as Record<string, unknown>;
  return {
    roomId: typeof record.roomId === 'string' ? record.roomId : undefined,
    roomUrl: typeof record.roomUrl === 'string' ? record.roomUrl : undefined
  };
}

function maybeResolveRoomContext(args: unknown): RoomContext | null {
  const { roomId, roomUrl } = readRoomTarget(args);
  if (roomUrl) return parseRoomUrl(roomUrl);
  if (roomId) return contextFromServerAndRoom(EXPRESS_SERVER_URL, roomId);
  return currentSession().currentRoom;
}

const NO_ROOM_ERROR =
  'No Excalidraw room is active. Paste a full room URL (e.g. https://draw.proklov.dev/r/<id>) ' +
  'and call set_room with `{ "roomUrl": "<that URL>" }` first. There is no ROOM_ID env var; ' +
  'set_room is the only way to select a room.';

function resolveRoomContext(args: unknown): RoomContext {
  const context = maybeResolveRoomContext(args);
  if (!context) throw new Error(NO_ROOM_ERROR);
  return context;
}

function getRoomContext(): RoomContext {
  const context = roomContextStorage.getStore() || currentSession().currentRoom;
  if (!context) throw new Error(NO_ROOM_ERROR);
  return context;
}

const API_BASE = { toString: () => rewriteForInternal(getRoomContext().apiBase) };
const ROOM_URL = { toString: () => getRoomContext().roomUrl };

// API Response types
interface ApiResponse {
  success: boolean;
  element?: ServerElement;
  elements?: ServerElement[];
  message?: string;
  error?: string;
  count?: number;
}

interface SyncResponse {
  element?: ServerElement;
  elements?: ServerElement[];
}

// Helper functions to sync with Express server (canvas)
async function syncToCanvas(operation: string, data: any): Promise<SyncResponse | null> {
  if (!ENABLE_CANVAS_SYNC) {
    logger.debug('Canvas sync disabled, skipping');
    return null;
  }

  try {
    let url: string;
    let options: any;
    
    switch (operation) {
      case 'create':
        url = `${API_BASE}/elements`;
        options = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        };
        break;
        
      case 'update':
        url = `${API_BASE}/elements/${data.id}`;
        options = {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        };
        break;
        
      case 'delete':
        url = `${API_BASE}/elements/${data.id}`;
        options = { method: 'DELETE' };
        break;
        
      case 'batch_create':
        url = `${API_BASE}/elements/batch`;
        options = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ elements: data })
        };
        break;
        
      default:
        logger.warn(`Unknown sync operation: ${operation}`);
        return null;
    }

    logger.debug(`Syncing to canvas: ${operation}`, { url, data });
    const response = await fetch(url, options);

    // Parse JSON response regardless of HTTP status
    const result = await response.json() as ApiResponse;

    if (!response.ok) {
      logger.warn(`Canvas sync returned error status: ${response.status}`, result);
      throw new Error(result.error || `Canvas sync failed: ${response.status} ${response.statusText}`);
    }

    logger.debug(`Canvas sync successful: ${operation}`, result);
    return result as SyncResponse;
    
  } catch (error) {
    logger.warn(`Canvas sync failed for ${operation}:`, (error as Error).message);
    // Don't throw - we want MCP operations to work even if canvas is unavailable
    return null;
  }
}

// Helper to sync element creation to canvas
async function createElementOnCanvas(elementData: ServerElement): Promise<ServerElement | null> {
  const result = await syncToCanvas('create', elementData);
  return result?.element || elementData;
}

// Helper to sync element update to canvas  
async function updateElementOnCanvas(elementData: Partial<ServerElement> & { id: string }): Promise<ServerElement | null> {
  const result = await syncToCanvas('update', elementData);
  return result?.element || null;
}

// Helper to sync element deletion to canvas
async function deleteElementOnCanvas(elementId: string): Promise<any> {
  const result = await syncToCanvas('delete', { id: elementId });
  return result;
}

// Helper to sync batch creation to canvas
async function batchCreateElementsOnCanvas(elementsData: ServerElement[]): Promise<ServerElement[] | null> {
  const result = await syncToCanvas('batch_create', elementsData);
  return result?.elements || elementsData;
}

// Helper to fetch element from canvas
async function getElementFromCanvas(elementId: string): Promise<ServerElement | null> {
  if (!ENABLE_CANVAS_SYNC) {
    logger.debug('Canvas sync disabled, skipping fetch');
    return null;
  }

  try {
    const response = await fetch(`${API_BASE}/elements/${elementId}`);
    if (!response.ok) {
      logger.warn(`Failed to fetch element ${elementId}: ${response.status}`);
      return null;
    }
    const data = await response.json() as { element?: ServerElement };
    return data.element || null;
  } catch (error) {
    logger.error('Error fetching element from canvas:', error);
    return null;
  }
}

type Point = { x: number; y: number };
type AgentColor = { background: string; stroke: string };
type AgentActivityTarget = {
  point?: Point;
  elements?: ServerElement[];
  elementIds?: string[];
};

function parseAgentColor(value: string | undefined): AgentColor {
  if (!value) {
    return { background: '#e7f5ff', stroke: '#1971c2' };
  }

  try {
    const parsed = JSON.parse(value) as Partial<AgentColor>;
    if (typeof parsed.background === 'string' && typeof parsed.stroke === 'string') {
      return { background: parsed.background, stroke: parsed.stroke };
    }
  } catch {
    // Fall back to treating the env var as a stroke color.
  }

  return { background: '#e7f5ff', stroke: value };
}

function makeWebSocketUrl(serverUrl: string, roomId: string): string | null {
  try {
    const url = new URL(serverUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = `/ws/r/${roomId}`;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch (error) {
    logger.warn('MCP agent cursor disabled because EXPRESS_SERVER_URL is not a valid URL', {
      serverUrl,
      error: (error as Error).message
    });
    return null;
  }
}

function getElementBounds(element: ServerElement): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (typeof element.x !== 'number' || typeof element.y !== 'number') {
    return null;
  }

  const points = Array.isArray(element.points) ? element.points : [];
  if (points.length > 0) {
    const absolutePoints = points
      .filter((point: unknown): point is [number, number] => (
        Array.isArray(point) &&
        typeof point[0] === 'number' &&
        typeof point[1] === 'number'
      ))
      .map(([x, y]) => ({ x: element.x + x, y: element.y + y }));

    if (absolutePoints.length > 0) {
      return {
        minX: Math.min(...absolutePoints.map(point => point.x)),
        minY: Math.min(...absolutePoints.map(point => point.y)),
        maxX: Math.max(...absolutePoints.map(point => point.x)),
        maxY: Math.max(...absolutePoints.map(point => point.y))
      };
    }
  }

  const width = typeof element.width === 'number' ? element.width : 0;
  const height = typeof element.height === 'number' ? element.height : 0;
  return {
    minX: element.x,
    minY: element.y,
    maxX: element.x + width,
    maxY: element.y + height
  };
}

function getElementsCenter(elements: ServerElement[]): Point | null {
  const bounds = elements.map(getElementBounds).filter((value): value is NonNullable<typeof value> => !!value);
  if (bounds.length === 0) return null;

  const minX = Math.min(...bounds.map(bound => bound.minX));
  const minY = Math.min(...bounds.map(bound => bound.minY));
  const maxX = Math.max(...bounds.map(bound => bound.maxX));
  const maxY = Math.max(...bounds.map(bound => bound.maxY));

  return { x: minX + (maxX - minX) / 2, y: minY + (maxY - minY) / 2 };
}

function selectedElementMap(elementIds: string[] = [], limit = 50): Record<string, boolean> {
  return Object.fromEntries(elementIds.slice(0, limit).map(id => [id, true]));
}

async function getElementsFromCanvas(elementIds: string[]): Promise<ServerElement[]> {
  const elements = await Promise.all(elementIds.map(id => getElementFromCanvas(id)));
  return elements.filter((element): element is ServerElement => !!element);
}

class AgentPresence {
  private readonly enabled = ENABLE_AGENT_CURSOR;
  private readonly clientId = `mcp-agent-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  private readonly name = process.env.MCP_AGENT_NAME || 'MCP Agent';
  private readonly color = parseAgentColor(process.env.MCP_AGENT_COLOR);
  private wsUrl: string | null = null;
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private pendingMessages: Record<string, any>[] = [];
  private reconnectAttempts = 0;
  private intentionallyClosed = false;
  private lastPoint: Point | null = null;
  private lastContext: RoomContext | null = null;

  connect(context: RoomContext = getRoomContext()): void {
    if (!this.enabled || this.intentionallyClosed) return;
    const nextWsUrl = makeWebSocketUrl(context.serverUrl, context.roomId);
    if (this.wsUrl && nextWsUrl && this.wsUrl !== nextWsUrl && this.ws) {
      this.pendingMessages = [];
      this.ws.close(1000, 'MCP agent cursor switching rooms');
      this.ws = null;
    }
    this.wsUrl = nextWsUrl;
    if (!this.wsUrl) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;

    try {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.on('open', () => {
        this.reconnectAttempts = 0;
        this.sendRaw({
          type: 'client_join',
          clientId: this.clientId,
          username: this.name,
          color: this.color
        });
        const pending = this.pendingMessages.splice(0);
        for (const message of pending) {
          this.sendRaw(message);
        }
      });

      this.ws.on('close', () => {
        this.ws = null;
        if (!this.intentionallyClosed) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (error) => {
        logger.debug('MCP agent cursor websocket error', { error: error.message });
      });
    } catch (error) {
      logger.debug('Failed to create MCP agent cursor websocket', { error: (error as Error).message });
      this.scheduleReconnect();
    }
  }

  startActivity(toolName: string, target: AgentActivityTarget = {}, context: RoomContext = getRoomContext()): void {
    if (!this.enabled) return;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    const point = target.point || (target.elements ? getElementsCenter(target.elements) : null) || this.lastPoint;
    if (!point) return;

    const ids = target.elementIds || target.elements?.map(element => element.id) || [];
    this.lastPoint = point;
    this.lastContext = context;
    this.sendPointerUpdate({
      username: `${this.name} · ${toolName}`,
      pointer: { ...point, tool: 'pointer', renderCursor: true },
      button: 'down',
      selectedElementIds: selectedElementMap(ids)
    }, context);
  }

  finishActivity(): void {
    if (!this.enabled || !this.lastPoint) return;
    const context = this.lastContext || getRoomContext();

    this.sendPointerUpdate({
      username: this.name,
      pointer: { ...this.lastPoint, tool: 'pointer', renderCursor: true },
      button: 'up',
      selectedElementIds: {}
    }, context);

    this.idleTimer = setTimeout(() => {
      if (!this.lastPoint) return;
      const idleContext = this.lastContext || context;
      this.sendPointerUpdate({
        username: this.name,
        pointer: { ...this.lastPoint, tool: 'pointer', renderCursor: false },
        button: 'up',
        selectedElementIds: {}
      }, idleContext);
    }, 8000);
  }

  disconnect(): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.pendingMessages = [];
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      this.ws.close(1000, 'MCP server shutting down');
    }
    this.ws = null;
  }

  private sendPointerUpdate(message: Record<string, any>, context?: RoomContext): void {
    this.sendRaw({
      type: 'pointer_update',
      clientId: this.clientId,
      color: this.color,
      ...message
    }, context);
  }

  private sendRaw(message: Record<string, any>, context?: RoomContext): void {
    if (!this.enabled) return;
    this.connect(context);

    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(message));
      } catch (error) {
        logger.debug('Failed to send MCP agent cursor websocket message', { error: (error as Error).message });
      }
      return;
    }

    this.pendingMessages.push(message);
    if (this.pendingMessages.length > 5) {
      this.pendingMessages.shift();
    }
  }

  private scheduleReconnect(): void {
    if (!this.enabled || this.intentionallyClosed || this.reconnectTimer) return;

    const delay = Math.min(5000, 250 * (2 ** this.reconnectAttempts));
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}

// In-memory storage for scene state
interface SceneState {
  theme: string;
  viewport: { x: number; y: number; zoom: number };
  selectedElements: Set<string>;
  groups: Map<string, string[]>;
}

const sceneState: SceneState = {
  theme: 'light',
  viewport: { x: 0, y: 0, zoom: 1 },
  selectedElements: new Set(),
  groups: new Map()
};

const agentPresence = new AgentPresence();

// Points schema: accept both {x, y} objects and [x, y] tuples
const PointObjectSchema = z.object({ x: z.number(), y: z.number() });
const PointTupleSchema = z.tuple([z.number(), z.number()]);
const PointSchema = z.union([PointObjectSchema, PointTupleSchema]);

// Normalize points to [x, y] tuple format that Excalidraw expects
function normalizePoints(points: Array<{ x: number; y: number } | [number, number]>): [number, number][] {
  return points.map(p => {
    if (Array.isArray(p)) return p as [number, number];
    return [p.x, p.y] as [number, number];
  });
}

// Schema definitions using zod
const ElementSchema = z.object({
  id: z.string().optional(),
  type: z.enum(Object.values(EXCALIDRAW_ELEMENT_TYPES) as [ExcalidrawElementType, ...ExcalidrawElementType[]]),
  x: z.number(),
  y: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
  points: z.array(PointSchema).optional(),
  backgroundColor: z.string().optional(),
  strokeColor: z.string().optional(),
  strokeWidth: z.number().optional(),
  roughness: z.number().optional(),
  opacity: z.number().optional(),
  text: z.string().optional(),
  fontSize: z.number().optional(),
  fontFamily: z.union([z.string(), z.number()]).optional(),
  groupIds: z.array(z.string()).optional(),
  locked: z.boolean().optional(),
  strokeStyle: z.string().optional(),
  roundness: z.object({ type: z.number(), value: z.number().optional() }).nullable().optional(),
  fillStyle: z.string().optional(),
  elbowed: z.boolean().optional(),
  startElementId: z.string().optional(),
  endElementId: z.string().optional(),
  endArrowhead: z.string().optional(),
  startArrowhead: z.string().optional(),
});

const ElementIdSchema = z.object({
  id: z.string()
});

const ElementIdsSchema = z.object({
  elementIds: z.array(z.string())
});

const GroupIdSchema = z.object({
  groupId: z.string()
});

const AlignElementsSchema = z.object({
  elementIds: z.array(z.string()),
  alignment: z.enum(['left', 'center', 'right', 'top', 'middle', 'bottom'])
});

const DistributeElementsSchema = z.object({
  elementIds: z.array(z.string()),
  direction: z.enum(['horizontal', 'vertical'])
});

const QuerySchema = z.object({
  type: z.enum(Object.values(EXCALIDRAW_ELEMENT_TYPES) as [ExcalidrawElementType, ...ExcalidrawElementType[]]).optional(),
  filter: z.record(z.any()).optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
  filePath: z.string().optional(),
  bbox: z.object({
    x_min: z.number().optional(),
    x_max: z.number().optional(),
    y_min: z.number().optional(),
    y_max: z.number().optional()
  }).optional()
});

const ResourceSchema = z.object({
  resource: z.enum(['scene', 'library', 'theme', 'elements']),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
  filePath: z.string().optional()
});

const DescribeSceneSchema = z.object({
  detail: z.enum(SCENE_DESCRIPTION_DETAILS as unknown as [SceneDescriptionDetail, ...SceneDescriptionDetail[]]).optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
  sectionIndex: z.number().int().nonnegative().optional(),
  sectionLimit: z.number().int().positive().optional(),
  maxTextLength: z.number().int().positive().optional(),
  types: z.array(z.enum(Object.values(EXCALIDRAW_ELEMENT_TYPES) as [ExcalidrawElementType, ...ExcalidrawElementType[]])).optional(),
  textIncludes: z.string().optional(),
  filePath: z.string().optional(),
  bbox: z.object({
    x_min: z.number().optional(),
    x_max: z.number().optional(),
    y_min: z.number().optional(),
    y_max: z.number().optional()
  }).optional()
});

const DEFAULT_QUERY_LIMIT = 100;

function clampPositiveInt(value: number | undefined, fallback: number, max = 5000): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function clampNonNegativeInt(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function paginateItems<T>(items: T[], limit: number | undefined, offset: number | undefined): { offset: number; limit: number; page: T[] } {
  const safeOffset = clampNonNegativeInt(offset);
  const safeLimit = clampPositiveInt(limit, DEFAULT_QUERY_LIMIT);
  return {
    offset: safeOffset,
    limit: safeLimit,
    page: items.slice(safeOffset, safeOffset + safeLimit)
  };
}

function writeJsonFile(filePath: string, data: unknown): string {
  const safePath = sanitizeFilePath(filePath);
  fs.writeFileSync(safePath, JSON.stringify(data, null, 2), 'utf-8');
  return safePath;
}

// Diagram design guide — injected into LLM context via read_diagram_guide tool
const DIAGRAM_DESIGN_GUIDE = `# Excalidraw Diagram Design Guide

## Color Palette

### Stroke Colors (use for borders & text)
| Name    | Hex       | Use for                     |
|---------|-----------|-----------------------------|
| Black   | #1e1e1e   | Default text & borders      |
| Red     | #e03131   | Errors, warnings, critical  |
| Green   | #2f9e44   | Success, approved, healthy  |
| Blue    | #1971c2   | Primary actions, links      |
| Purple  | #9c36b5   | Services, middleware        |
| Orange  | #e8590c   | Async, queues, events       |
| Cyan    | #0c8599   | Data stores, databases      |
| Gray    | #868e96   | Annotations, secondary      |

### Fill Colors (use for backgroundColor — pastel fills)
| Name         | Hex       | Pairs with stroke |
|--------------|-----------|-------------------|
| Light Red    | #ffc9c9   | #e03131           |
| Light Green  | #b2f2bb   | #2f9e44           |
| Light Blue   | #a5d8ff   | #1971c2           |
| Light Purple | #eebefa   | #9c36b5           |
| Light Orange | #ffd8a8   | #e8590c           |
| Light Cyan   | #99e9f2   | #0c8599           |
| Light Gray   | #e9ecef   | #868e96           |
| White        | #ffffff   | #1e1e1e           |

## Sizing Rules

- **Minimum shape size**: width >= 120px, height >= 60px
- **Font sizes**: body text >= 16, titles/headers >= 20, small labels >= 14
- **Padding**: leave at least 20px inside shapes for text breathing room
- **Arrow length**: minimum 80px between connected shapes
- **Consistent sizing**: keep same-role shapes identical dimensions

## Layout Patterns

- **Grid snap**: align to 20px grid for clean layouts
- **Spacing**: 40–80px gap between adjacent shapes
- **Flow direction**: top-to-bottom (vertical) or left-to-right (horizontal)
- **Hierarchy**: important nodes larger or higher; left-to-right = temporal order
- **Grouping**: cluster related elements visually; use background rectangles as zones

## Arrow Binding Best Practices

- **Always bind**: use \`startElementId\` / \`endElementId\` to connect arrows to shapes
- **Dashed arrows**: use \`strokeStyle: "dashed"\` for async, optional, or event flows
- **Dotted arrows**: use \`strokeStyle: "dotted"\` for weak dependencies or annotations
- **Arrowheads**: default "arrow" for directed flow; "dot" for data stores; null for lines
- **Label arrows**: set \`text\` on arrows to describe the relationship (e.g., "HTTP", "publishes")

## Diagram Type Templates

### Architecture Diagram
- Shapes: 160×80 rectangles for services, 120×60 for small components
- Colors: different fill per layer (frontend=blue, backend=purple, data=cyan)
- Arrows: solid for sync calls, dashed for async/events
- Zones: large light-gray background rectangles with 20px fontSize labels

### Flowchart
- Shapes: 140×70 rectangles for steps, 100×100 diamonds for decisions
- Flow: top-to-bottom, 60px vertical spacing
- Colors: green start, red end, blue for process steps
- Arrows: solid, with "Yes"/"No" labels from diamonds

### ER Diagram
- Shapes: 180×40 per entity (wider for attribute lists)
- Layout: 80px between entities
- Arrows: use start/end arrowheads to show cardinality
- Colors: light-blue fill for entities, no fill for junction tables

## Anti-Patterns to Avoid

1. **Overlapping elements** — always leave gaps; use distribute_elements
2. **Cramped spacing** — minimum 40px between shapes
3. **Tiny fonts** — never below 14px; prefer 16+
4. **Manual arrow coordinates** — always use startElementId/endElementId binding
5. **Too many colors** — limit to 3–4 fill colors per diagram
6. **Inconsistent sizes** — same-role shapes should be same width/height
7. **No labels** — every shape and meaningful arrow should have text
8. **Flat layouts** — use zones/groups to create visual hierarchy

## Drawing Order (Recommended)

1. **Background zones** — large rectangles with light fill, low opacity
2. **Primary shapes** — services, entities, steps (with labels via \`text\`)
3. **Arrows** — connect shapes using binding IDs
4. **Annotations** — standalone text elements for notes, titles
5. **Refinement** — align, distribute, adjust spacing, screenshot to verify
`;

const ROOM_TARGET_INPUT_PROPERTIES = {
  roomUrl: {
    type: 'string',
    description: 'Optional Excalidraw Zephy room URL, e.g. https://draw.proklov.dev/r/<roomId>. Overrides the active/default room for this call.'
  },
  roomId: {
    type: 'string',
    description: 'Optional room id. Uses EXPRESS_SERVER_URL as the server origin. Overrides the active/default room for this call.'
  }
};

function withRoomTarget(tool: Tool): Tool {
  const inputSchema = tool.inputSchema as Record<string, any> | undefined;
  if (!inputSchema || inputSchema.type !== 'object') return tool;
  return {
    ...tool,
    inputSchema: {
      ...inputSchema,
      type: 'object' as const,
      properties: {
        ...(inputSchema.properties || {}),
        ...ROOM_TARGET_INPUT_PROPERTIES
      }
    }
  };
}

// Tool definitions
const rawTools: Tool[] = [
  {
    name: 'set_room',
    description: 'Set the active Excalidraw Zephy room for later MCP tool calls. Use this when the user pastes a room URL or room id.',
    inputSchema: {
      type: 'object',
      properties: {
        ...ROOM_TARGET_INPUT_PROPERTIES
      }
    }
  },
  {
    name: 'get_room',
    description: 'Show the currently active/default Excalidraw Zephy room used by MCP tool calls.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'create_element',
    description: 'Create a new Excalidraw element. For arrows, use startElementId/endElementId to bind to shapes (auto-routes to edges).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Custom element ID (optional, auto-generated if omitted). Use with startElementId/endElementId in batch_create_elements.' },
        type: {
          type: 'string',
          enum: Object.values(EXCALIDRAW_ELEMENT_TYPES)
        },
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        backgroundColor: { type: 'string' },
        strokeColor: { type: 'string' },
        strokeWidth: { type: 'number' },
        strokeStyle: { type: 'string', description: 'Stroke style: solid, dashed, dotted' },
        roughness: { type: 'number' },
        opacity: { type: 'number' },
        text: { type: 'string' },
        fontSize: { type: 'number' },
        fontFamily: { type: ['string', 'number'], description: 'Font family: virgil/hand/handwritten (1), helvetica/sans/sans-serif (2), cascadia/mono/monospace (3), excalifont (5), nunito (6), lilita/lilita one (7), comic shanns/comic (8), or numeric ID' },
        startElementId: { type: 'string', description: 'For arrows: ID of the element to bind the arrow start to. Arrow auto-routes to element edge.' },
        endElementId: { type: 'string', description: 'For arrows: ID of the element to bind the arrow end to. Arrow auto-routes to element edge.' },
        endArrowhead: { type: 'string', description: 'Arrowhead style at end: arrow, bar, dot, triangle, or null' },
        startArrowhead: { type: 'string', description: 'Arrowhead style at start: arrow, bar, dot, triangle, or null' }
      },
      required: ['type', 'x', 'y']
    }
  },
  {
    name: 'update_element',
    description: 'Update an existing Excalidraw element',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        type: {
          type: 'string',
          enum: Object.values(EXCALIDRAW_ELEMENT_TYPES)
        },
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        backgroundColor: { type: 'string' },
        strokeColor: { type: 'string' },
        strokeWidth: { type: 'number' },
        strokeStyle: { type: 'string' },
        roughness: { type: 'number' },
        opacity: { type: 'number' },
        text: { type: 'string' },
        fontSize: { type: 'number' },
        fontFamily: { type: ['string', 'number'], description: 'Font family: virgil/hand/handwritten (1), helvetica/sans/sans-serif (2), cascadia/mono/monospace (3), excalifont (5), nunito (6), lilita/lilita one (7), comic shanns/comic (8), or numeric ID' }
      },
      required: ['id']
    }
  },
  {
    name: 'delete_element',
    description: 'Delete an Excalidraw element',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' }
      },
      required: ['id']
    }
  },
  {
    name: 'query_elements',
    description: 'Query Excalidraw elements with optional filters. Results are paginated by default; use offset/limit or filePath for agent-friendly large-result workflows.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: Object.values(EXCALIDRAW_ELEMENT_TYPES)
        },
        filter: {
          type: 'object',
          additionalProperties: true
        },
        limit: {
          type: 'number',
          description: 'Maximum elements to return (default 100).'
        },
        offset: {
          type: 'number',
          description: 'Number of matching elements to skip.'
        },
        filePath: {
          type: 'string',
          description: 'Optional file path to write the paginated query result JSON.'
        },
        bbox: {
          type: 'object',
          description: 'Bounding box filter — only return elements whose origin (x, y) falls within the given coordinate range',
          properties: {
            x_min: { type: 'number' },
            x_max: { type: 'number' },
            y_min: { type: 'number' },
            y_max: { type: 'number' }
          }
        }
      }
    }
  },
  {
    name: 'get_resource',
    description: 'Get an Excalidraw resource. Element resources are paginated by default; use offset/limit or filePath for large canvases.',
    inputSchema: {
      type: 'object',
      properties: {
        resource: { 
          type: 'string', 
          enum: ['scene', 'library', 'theme', 'elements'] 
        },
        limit: {
          type: 'number',
          description: 'For element resources, maximum elements to return (default 100).'
        },
        offset: {
          type: 'number',
          description: 'For element resources, number of elements to skip.'
        },
        filePath: {
          type: 'string',
          description: 'Optional file path to write the resource JSON.'
        }
      },
      required: ['resource']
    }
  },
  {
    name: 'group_elements',
    description: 'Group multiple elements together',
    inputSchema: {
      type: 'object',
      properties: {
        elementIds: { 
          type: 'array',
          items: { type: 'string' }
        }
      },
      required: ['elementIds']
    }
  },
  {
    name: 'ungroup_elements',
    description: 'Ungroup a group of elements',
    inputSchema: {
      type: 'object',
      properties: {
        groupId: { type: 'string' }
      },
      required: ['groupId']
    }
  },
  {
    name: 'align_elements',
    description: 'Align elements to a specific position',
    inputSchema: {
      type: 'object',
      properties: {
        elementIds: { 
          type: 'array',
          items: { type: 'string' }
        },
        alignment: { 
          type: 'string', 
          enum: ['left', 'center', 'right', 'top', 'middle', 'bottom'] 
        }
      },
      required: ['elementIds', 'alignment']
    }
  },
  {
    name: 'distribute_elements',
    description: 'Distribute elements evenly',
    inputSchema: {
      type: 'object',
      properties: {
        elementIds: { 
          type: 'array',
          items: { type: 'string' }
        },
        direction: { 
          type: 'string', 
          enum: ['horizontal', 'vertical'] 
        }
      },
      required: ['elementIds', 'direction']
    }
  },
  {
    name: 'lock_elements',
    description: 'Lock elements to prevent modification',
    inputSchema: {
      type: 'object',
      properties: {
        elementIds: { 
          type: 'array',
          items: { type: 'string' }
        }
      },
      required: ['elementIds']
    }
  },
  {
    name: 'unlock_elements',
    description: 'Unlock elements to allow modification',
    inputSchema: {
      type: 'object',
      properties: {
        elementIds: { 
          type: 'array',
          items: { type: 'string' }
        }
      },
      required: ['elementIds']
    }
  },
  {
    name: 'create_from_mermaid',
    description: 'Convert a Mermaid diagram to Excalidraw elements and render them on the canvas',
    inputSchema: {
      type: 'object',
      properties: {
        mermaidDiagram: {
          type: 'string',
          description: 'The Mermaid diagram definition (e.g., "graph TD; A-->B; B-->C;")'
        },
        config: {
          type: 'object',
          description: 'Optional Mermaid configuration',
          properties: {
            startOnLoad: { type: 'boolean' },
            flowchart: {
              type: 'object',
              properties: {
                curve: { type: 'string', enum: ['linear', 'basis'] }
              }
            },
            themeVariables: {
              type: 'object',
              properties: {
                fontSize: { type: 'string' }
              }
            },
            maxEdges: { type: 'number' },
            maxTextSize: { type: 'number' }
          }
        }
      },
      required: ['mermaidDiagram']
    }
  },
  {
    name: 'batch_create_elements',
    description: 'Create multiple Excalidraw elements at once. For arrows, use startElementId/endElementId to bind arrows to shapes — Excalidraw auto-routes to element edges. Assign custom id to shapes so arrows can reference them.',
    inputSchema: {
      type: 'object',
      properties: {
        elements: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Custom element ID. Arrows can reference this via startElementId/endElementId.' },
              type: {
                type: 'string',
                enum: Object.values(EXCALIDRAW_ELEMENT_TYPES)
              },
              x: { type: 'number' },
              y: { type: 'number' },
              width: { type: 'number' },
              height: { type: 'number' },
              backgroundColor: { type: 'string' },
              strokeColor: { type: 'string' },
              strokeWidth: { type: 'number' },
              strokeStyle: { type: 'string', description: 'Stroke style: solid, dashed, dotted' },
              roughness: { type: 'number' },
              opacity: { type: 'number' },
              text: { type: 'string' },
              fontSize: { type: 'number' },
              fontFamily: { type: ['string', 'number'], description: 'Font family: virgil/hand/handwritten (1), helvetica/sans/sans-serif (2), cascadia/mono/monospace (3), excalifont (5), nunito (6), lilita/lilita one (7), comic shanns/comic (8), or numeric ID' },
              startElementId: { type: 'string', description: 'For arrows: ID of element to bind arrow start to' },
              endElementId: { type: 'string', description: 'For arrows: ID of element to bind arrow end to' },
              endArrowhead: { type: 'string', description: 'Arrowhead style at end: arrow, bar, dot, triangle, or null' },
              startArrowhead: { type: 'string', description: 'Arrowhead style at start: arrow, bar, dot, triangle, or null' }
            },
            required: ['type', 'x', 'y']
          }
        }
      },
      required: ['elements']
    }
  },
  {
    name: 'get_element',
    description: 'Get a single Excalidraw element by ID',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The element ID' }
      },
      required: ['id']
    }
  },
  {
    name: 'clear_canvas',
    description: 'Clear all elements from the canvas',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'export_scene',
    description: 'Export the current canvas to .excalidraw JSON format. Optionally write to a file.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Optional file path to write the .excalidraw JSON file'
        }
      }
    }
  },
  {
    name: 'import_scene',
    description: 'Import elements from a .excalidraw JSON file or raw JSON data',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Path to a .excalidraw JSON file'
        },
        data: {
          type: 'string',
          description: 'Raw .excalidraw JSON string (alternative to filePath)'
        },
        mode: {
          type: 'string',
          enum: ['replace', 'merge'],
          description: '"replace" clears canvas first, "merge" appends to existing elements'
        }
      },
      required: ['mode']
    }
  },
  {
    name: 'export_to_image',
    description: 'Export the current canvas to PNG or SVG image. Requires the canvas frontend to be open in a browser.',
    inputSchema: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['png', 'svg'],
          description: 'Image format'
        },
        filePath: {
          type: 'string',
          description: 'Optional file path to save the image'
        },
        background: {
          type: 'boolean',
          description: 'Include background in export (default: true)'
        }
      },
      required: ['format']
    }
  },
  {
    name: 'duplicate_elements',
    description: 'Duplicate elements with a configurable offset',
    inputSchema: {
      type: 'object',
      properties: {
        elementIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'IDs of elements to duplicate'
        },
        offsetX: { type: 'number', description: 'Horizontal offset (default: 20)' },
        offsetY: { type: 'number', description: 'Vertical offset (default: 20)' }
      },
      required: ['elementIds']
    }
  },
  {
    name: 'snapshot_scene',
    description: 'Save a named snapshot of the current canvas state for later restoration',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name for this snapshot'
        }
      },
      required: ['name']
    }
  },
  {
    name: 'restore_snapshot',
    description: 'Restore the canvas from a previously saved named snapshot',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the snapshot to restore'
        }
      },
      required: ['name']
    }
  },
  {
    name: 'describe_scene',
    description: 'Get an AI-readable description of the current canvas. Defaults to a bounded overview with spatial sections; use detail="elements" with sectionIndex/offset/limit to page through large boards, or detail="full" for the legacy complete dump.',
    inputSchema: {
      type: 'object',
      properties: {
        detail: {
          type: 'string',
          enum: SCENE_DESCRIPTION_DETAILS,
          description: 'overview returns summary + section index (default); elements/connections/groups return paginated focused lists; full returns all elements plus connections/groups.'
        },
        limit: {
          type: 'number',
          description: 'Maximum items to return for paginated detail modes. Defaults to 80 for elements and all items for full.'
        },
        offset: {
          type: 'number',
          description: 'Number of matching items to skip before returning paginated results.'
        },
        sectionIndex: {
          type: 'number',
          description: 'Focus on one spatial section from the overview section index.'
        },
        sectionLimit: {
          type: 'number',
          description: 'Maximum sections to list in overview mode.'
        },
        maxTextLength: {
          type: 'number',
          description: 'Maximum characters to show per text/label snippet.'
        },
        filePath: {
          type: 'string',
          description: 'Optional file path to write the scene description markdown/text instead of returning the full text inline.'
        },
        types: {
          type: 'array',
          items: {
            type: 'string',
            enum: Object.values(EXCALIDRAW_ELEMENT_TYPES)
          },
          description: 'Filter to element types such as text, rectangle, arrow, image.'
        },
        textIncludes: {
          type: 'string',
          description: 'Filter to elements whose text or label contains this case-insensitive substring.'
        },
        bbox: {
          type: 'object',
          description: 'Filter to elements intersecting this coordinate box.',
          properties: {
            x_min: { type: 'number' },
            x_max: { type: 'number' },
            y_min: { type: 'number' },
            y_max: { type: 'number' }
          }
        }
      }
    }
  },
  {
    name: 'get_canvas_screenshot',
    description: 'Take a screenshot of the current canvas and return it as an image, or save it to a PNG file. Requires the canvas frontend to be open in a browser. Use this to visually verify what the diagram looks like.',
    inputSchema: {
      type: 'object',
      properties: {
        background: {
          type: 'boolean',
          description: 'Include background in screenshot (default: true)'
        },
        filePath: {
          type: 'string',
          description: 'Optional file path to save the PNG screenshot.'
        }
      }
    }
  },
  {
    name: 'read_diagram_guide',
    description: 'Returns a comprehensive design guide for creating beautiful Excalidraw diagrams: color palette, sizing rules, layout patterns, arrow binding best practices, diagram templates, and anti-patterns. Call this before creating diagrams to produce professional results.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'export_to_excalidraw_url',
    description: 'Export the current canvas to a shareable excalidraw.com URL. The diagram is encrypted and uploaded; anyone with the URL can view it. Returns the shareable link.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'set_viewport',
    description: 'Control the canvas viewport (camera). Auto-fit all elements, center on a specific element, or set zoom/scroll directly. Requires the canvas frontend open in a browser.',
    inputSchema: {
      type: 'object',
      properties: {
        scrollToContent: {
          type: 'boolean',
          description: 'Auto-fit all elements in view (zoom-to-fit)'
        },
        scrollToElementId: {
          type: 'string',
          description: 'Center the view on a specific element by ID'
        },
        zoom: {
          type: 'number',
          description: 'Zoom level (0.1–10, where 1 = 100%)'
        },
        offsetX: {
          type: 'number',
          description: 'Horizontal scroll offset'
        },
        offsetY: {
          type: 'number',
          description: 'Vertical scroll offset'
        }
      }
    }
  }
];

const tools: Tool[] = rawTools.map(withRoomTarget);

const MCP_SERVER_INSTRUCTIONS = [
  "This server drives a self-hosted Excalidraw canvas split into rooms.",
  "Every canvas tool operates on whichever room is currently active.",
  "",
  "Room targeting:",
  "  • A room URL looks like https://<host>/r/<id>, e.g. https://draw.proklov.dev/r/t5E00jYl5vK1",
  "  • If the user pastes (or otherwise gives) a room URL during the conversation, call `set_room` with `{ \"roomUrl\": \"<that URL>\" }` before any other canvas tool — that pins the room for the rest of the session.",
  "  • If no room is set when a canvas tool is called, it errors. Fall back to `set_room` (or pass `roomUrl` as an arg on the tool call) instead of asking the user to re-install.",
  "  • To switch rooms mid-session, call `set_room` again with the new URL. To check the current room, call `get_room`.",
  "  • Per-call overrides also work: pass `roomUrl` (full URL) or `roomId` on any individual canvas tool call to target a different room just for that call.",
  "",
  "Reading large boards:",
  "  • Default to `describe_scene` with `detail: \"overview\"` — it returns a bounded summary plus a section index even for huge canvases. Use `sectionIndex`, `types`, `textIncludes`, `offset`, `limit` to drill in. Reach for `detail: \"full\"` only when you genuinely need the complete dump.",
  "  • `get_canvas_screenshot` defaults to a 1600px-longest-edge cap so big scenes render in seconds. Override with `maxDim`, `scale`, `bbox`, or `timeoutMs` if you need pixel-perfect output or only a slice.",
  "  • Screenshots require at least one browser tab open in the room — the export pipeline is client-driven."
].join("\n");

// Build a fresh, fully-configured MCP server. Stdio mode calls this once;
// the remote /mcp HTTP transport calls it once per connector session so each
// session gets its own Server (Server.connect binds one transport).
// Per-session sticky state (currentRoom) lives in mcpSessionStorage, not on
// the Server instance — that's what makes one factory safe for both modes.
export function buildMcpServer(): Server {
  const server = new Server(
    {
      name: "mcp-excalidraw-server",
      version: "2.0.0",
      description: "Programmatic canvas toolkit for Excalidraw with file I/O, image export, and real-time sync"
    },
    {
      capabilities: {
        tools: Object.fromEntries(tools.map(tool => [tool.name, {
          description: tool.description,
          inputSchema: tool.inputSchema
        }]))
      },
      instructions: MCP_SERVER_INSTRUCTIONS
    }
  );
  server.setRequestHandler(CallToolRequestSchema, callToolHandler);
  server.setRequestHandler(ListToolsRequestSchema, listToolsHandler);
  return server;
}

// Helper function to convert text property to label format for Excalidraw
function convertTextToLabel(element: ServerElement): ServerElement {
  const { text, ...rest } = element;
  if (text) {
    // For standalone text elements, keep text as direct property
    if (element.type === 'text') {
      return element; // Keep text as direct property
    }
    // For other elements (rectangle, ellipse, diamond), convert to label format
    return {
      ...rest,
      label: { text }
    } as ServerElement;
  }
  return element;
}

// Format an error caught from a tool handler into something useful for the
// agent. Plain `error.message` swallows too much: node-fetch's FetchError
// renders as "request to URL failed, reason: " when the underlying cause
// has no message (timeouts, abortions). Server-side response bodies don't
// surface at all unless the handler unpacked them. This helper digs into
// `cause`, `code`, `errno`, `name`, and includes a stack head for unknown
// shapes so the agent gets a real signal back instead of an opaque blob.
function formatToolError(error: unknown): string {
  if (error == null) return '(unknown error: null)';
  if (typeof error === 'string') return error;
  const e = error as { message?: string; name?: string; code?: string; errno?: string; cause?: { message?: string; code?: string }; stack?: string };
  const parts: string[] = [];
  const msg = e.message && e.message.trim();
  if (msg) parts.push(msg);
  // node-fetch fills in `code` (ENOTFOUND, ECONNREFUSED, ETIMEDOUT, EAI_AGAIN)
  // and sometimes wraps the underlying system error in `cause`.
  if (e.code) parts.push(`code=${e.code}`);
  if (e.errno && e.errno !== e.code) parts.push(`errno=${e.errno}`);
  if (e.cause && (e.cause.message || e.cause.code)) {
    const c = [e.cause.message, e.cause.code].filter(Boolean).join(' ');
    if (c && !parts.join(' ').includes(c)) parts.push(`cause: ${c}`);
  }
  if (parts.length === 0) {
    // No usable message anywhere. Surface the constructor name + first stack frame
    // so the agent at least knows WHAT kind of error and where it came from.
    const ctor = e.name || 'Error';
    const frame = (e.stack || '').split('\n').slice(0, 2).join(' ');
    return `${ctor} (no message). ${frame}`.trim();
  }
  return parts.join(' — ');
}

// Wrapper around node-fetch that throws with a useful message instead of
// the empty-reason FetchError. Use for any HTTP call from a tool handler.
async function fetchOrThrow(url: string, init?: Parameters<typeof fetch>[1]): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, init) as unknown as Response;
  } catch (err) {
    const e = err as { message?: string; code?: string; cause?: { message?: string; code?: string } };
    const cause = e.cause ? (e.cause.message || e.cause.code || '') : '';
    const reason = e.message?.trim() || e.code || cause || 'unknown network error';
    throw new Error(`Network error reaching ${url}: ${reason}${e.code ? ` (${e.code})` : ''}`);
  }
  if (!response.ok) {
    let body = '';
    try { body = (await response.text()).slice(0, 800); } catch {}
    let parsedError = '';
    try {
      const j = JSON.parse(body);
      parsedError = j?.error || '';
    } catch {}
    const detail = parsedError || body || '(empty body)';
    throw new Error(`HTTP ${response.status} ${response.statusText} from ${url}: ${detail}`);
  }
  return response;
}

// Set up request handler for tool calls.
// Defined as a named function so buildMcpServer() can register it on each
// per-session Server instance.
const callToolHandler = async (request: CallToolRequest) => {
  const { name, arguments: args } = request.params;
  const roomOptionalTools = new Set(['get_room', 'read_diagram_guide']);
  let roomContext: RoomContext | null;

  try {
    roomContext = roomOptionalTools.has(name) ? maybeResolveRoomContext(args) : resolveRoomContext(args);
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${(error as Error).message}` }],
      isError: true
    };
  }

  const runTool = async () => {
    let shouldFinishAgentActivity = false;
    const startAgentActivity = (toolName: string, target: AgentActivityTarget = {}) => {
      shouldFinishAgentActivity = true;
      agentPresence.startActivity(toolName, target, getRoomContext());
    };

  try {
    logger.info(`Handling tool call: ${name}`);
    
    switch (name) {
      case 'set_room': {
        const nextRoomContext = resolveRoomContext(args);
        currentSession().currentRoom = nextRoomContext;
        logger.info('Set active MCP Excalidraw room', nextRoomContext);
        return {
          content: [{
            type: 'text',
            text: `Active Excalidraw room set.\n\n${JSON.stringify(nextRoomContext, null, 2)}`
          }]
        };
      }

      case 'get_room': {
        const activeRoom = maybeResolveRoomContext(args);
        return {
          content: [{
            type: 'text',
            text: activeRoom
              ? `Active Excalidraw room:\n\n${JSON.stringify(activeRoom, null, 2)}`
              : NO_ROOM_ERROR
          }]
        };
      }

      case 'create_element': {
        const params = ElementSchema.parse(args);
        logger.info('Creating element via MCP', { type: params.type });

        const { startElementId, endElementId, id: customId, ...elementProps } = params;
        const id = customId || generateId();
        const element: ServerElement = {
          id,
          ...elementProps,
          points: elementProps.points ? normalizePoints(elementProps.points) : undefined,
          // Convert binding IDs to Excalidraw's start/end format
          ...(startElementId ? { start: { id: startElementId } } : {}),
          ...(endElementId ? { end: { id: endElementId } } : {}),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          version: 1
        };

        // Normalize fontFamily from string names to numeric values
        if (element.fontFamily !== undefined) {
          element.fontFamily = normalizeFontFamily(element.fontFamily);
        }

        // For bound arrows without explicit points, set a default
        if ((startElementId || endElementId) && !elementProps.points) {
          (element as any).points = [[0, 0], [100, 0]];
        }

        // Convert text to label format for Excalidraw
        const excalidrawElement = convertTextToLabel(element);
        startAgentActivity('create_element', {
          elements: [excalidrawElement],
          elementIds: [excalidrawElement.id]
        });

        // Create element directly on HTTP server (no local storage)
        const canvasElement = await createElementOnCanvas(excalidrawElement);
        
        if (!canvasElement) {
          throw new Error('Failed to create element: HTTP server unavailable');
        }
        
        logger.info('Element created via MCP and synced to canvas', { 
          id: excalidrawElement.id, 
          type: excalidrawElement.type,
          synced: !!canvasElement 
        });
        
        return {
          content: [{ 
            type: 'text', 
            text: `Element created successfully!\n\n${JSON.stringify(canvasElement, null, 2)}\n\n✅ Synced to canvas` 
          }]
        };
      }
      
      case 'update_element': {
        const params = ElementIdSchema.merge(ElementSchema.partial()).parse(args);
        const { id, points: rawPoints, ...updates } = params;

        if (!id) throw new Error('Element ID is required');

        // Build update payload with timestamp and version increment
        const updatePayload: Partial<ServerElement> & { id: string } = {
          id,
          ...updates,
          points: rawPoints ? normalizePoints(rawPoints) : undefined,
          updatedAt: new Date().toISOString()
        };

        // Normalize fontFamily from string names to numeric values
        if (updatePayload.fontFamily !== undefined) {
          updatePayload.fontFamily = normalizeFontFamily(updatePayload.fontFamily);
        }

        // Convert text to label format for Excalidraw
        const excalidrawElement = convertTextToLabel(updatePayload as ServerElement);
        const existingElementForPresence = await getElementFromCanvas(id);
        startAgentActivity('update_element', {
          elements: existingElementForPresence
            ? [{ ...existingElementForPresence, ...excalidrawElement }]
            : [excalidrawElement],
          elementIds: [id]
        });
        
        // Update element directly on HTTP server (no local storage)
        const canvasElement = await updateElementOnCanvas(excalidrawElement);
        
        if (!canvasElement) {
          throw new Error('Failed to update element: HTTP server unavailable or element not found');
        }
        
        logger.info('Element updated via MCP and synced to canvas', { 
          id: excalidrawElement.id, 
          synced: !!canvasElement 
        });
        
        return {
          content: [{ 
            type: 'text', 
            text: `Element updated successfully!\n\n${JSON.stringify(canvasElement, null, 2)}\n\n✅ Synced to canvas` 
          }]
        };
      }
      
      case 'delete_element': {
        const params = ElementIdSchema.parse(args);
        const { id } = params;
        const elementForPresence = await getElementFromCanvas(id);
        startAgentActivity('delete_element', {
          elements: elementForPresence ? [elementForPresence] : [],
          elementIds: [id]
        });

        // Delete element directly on HTTP server (no local storage)
        const canvasResult = await deleteElementOnCanvas(id);

        if (!canvasResult || !(canvasResult as ApiResponse).success) {
          throw new Error('Failed to delete element: HTTP server unavailable or element not found');
        }

        const result = { id, deleted: true, syncedToCanvas: true };
        logger.info('Element deleted via MCP and synced to canvas', result);

        return {
          content: [{
            type: 'text',
            text: `Element deleted successfully!\n\n${JSON.stringify(result, null, 2)}\n\n✅ Synced to canvas`
          }]
        };
      }
      
      case 'query_elements': {
        const params = QuerySchema.parse(args || {});
        const { type, filter, bbox } = params;

        try {
          // Build query parameters
          const queryParams = new URLSearchParams();
          if (type) queryParams.set('type', type);
          if (filter) {
            Object.entries(filter).forEach(([key, value]) => {
              queryParams.set(key, String(value));
            });
          }
          if (bbox) {
            if (bbox.x_min !== undefined) queryParams.set('x_min', String(bbox.x_min));
            if (bbox.x_max !== undefined) queryParams.set('x_max', String(bbox.x_max));
            if (bbox.y_min !== undefined) queryParams.set('y_min', String(bbox.y_min));
            if (bbox.y_max !== undefined) queryParams.set('y_max', String(bbox.y_max));
          }
          
          // Query elements from HTTP server
          const url = `${API_BASE}/elements/search?${queryParams}`;
          const response = await fetch(url);
          
          if (!response.ok) {
            throw new Error(`HTTP server error: ${response.status} ${response.statusText}`);
          }
          
          const data = await response.json() as ApiResponse;
          const results = data.elements || [];
          const { offset, limit, page } = paginateItems(results, params.limit, params.offset);
          const payload = {
            total: results.length,
            offset,
            limit,
            returned: page.length,
            elements: page
          };

          if (params.filePath) {
            const safePath = writeJsonFile(params.filePath, payload);
            return {
              content: [{
                type: 'text',
                text: `Query returned ${page.length}/${results.length} elements (offset ${offset}, limit ${limit}) and wrote JSON to ${safePath}`
              }]
            };
          }
          
          return {
            content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }]
          };
        } catch (error) {
          throw new Error(`Failed to query elements: ${(error as Error).message}`);
        }
      }
      
      case 'get_resource': {
        const params = ResourceSchema.parse(args);
        const { resource } = params;
        logger.info('Getting resource', { resource });
        
        let result: any;
        switch (resource) {
          case 'scene':
            result = {
              theme: sceneState.theme,
              viewport: sceneState.viewport,
              selectedElements: Array.from(sceneState.selectedElements)
            };
            break;
          case 'library':
          case 'elements':
            try {
              // Get elements from HTTP server
              const response = await fetch(`${API_BASE}/elements`);
              if (!response.ok) {
                throw new Error(`HTTP server error: ${response.status} ${response.statusText}`);
              }
              const data = await response.json() as ApiResponse;
              const allElements = data.elements || [];
              const { offset, limit, page } = paginateItems(allElements, params.limit, params.offset);
              result = {
                total: allElements.length,
                offset,
                limit,
                returned: page.length,
                elements: page
              };
            } catch (error) {
              throw new Error(`Failed to get elements: ${(error as Error).message}`);
            }
            break;
          case 'theme':
            result = {
              theme: sceneState.theme
            };
            break;
          default:
            throw new Error(`Unknown resource: ${resource}`);
        }

        if (params.filePath) {
          const safePath = writeJsonFile(params.filePath, result);
          return {
            content: [{
              type: 'text',
              text: `Resource "${resource}" written to ${safePath}`
            }]
          };
        }
        
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      }
      
      case 'group_elements': {
        const params = ElementIdsSchema.parse(args);
        const { elementIds } = params;

        try {
          startAgentActivity('group_elements', {
            elements: await getElementsFromCanvas(elementIds),
            elementIds
          });

          const groupId = generateId();
          sceneState.groups.set(groupId, elementIds);

          // Update elements on canvas with proper error handling
          // Fetch existing groups and append new groupId to preserve multi-group membership
          const updatePromises = elementIds.map(async (id) => {
            const element = await getElementFromCanvas(id);
            const existingGroups = element?.groupIds || [];
            const updatedGroupIds = [...existingGroups, groupId];
            return await updateElementOnCanvas({ id, groupIds: updatedGroupIds });
          });

          const results = await Promise.all(updatePromises);
          const successCount = results.filter(result => result).length;

          if (successCount === 0) {
            sceneState.groups.delete(groupId); // Rollback local state
            throw new Error('Failed to group any elements: HTTP server unavailable');
          }

          logger.info('Grouping elements', { elementIds, groupId, successCount });

          const result = { groupId, elementIds, successCount };
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
          };
        } catch (error) {
          throw new Error(`Failed to group elements: ${(error as Error).message}`);
        }
      }
      
      case 'ungroup_elements': {
        const params = GroupIdSchema.parse(args);
        const { groupId } = params;

        if (!sceneState.groups.has(groupId)) {
          throw new Error(`Group ${groupId} not found`);
        }

        try {
          const elementIds = sceneState.groups.get(groupId);
          sceneState.groups.delete(groupId);
          startAgentActivity('ungroup_elements', {
            elements: await getElementsFromCanvas(elementIds ?? []),
            elementIds: elementIds ?? []
          });

          // Update elements on canvas, removing only this specific groupId
          const updatePromises = (elementIds ?? []).map(async (id) => {
            // Fetch current element to get existing groupIds
            const element = await getElementFromCanvas(id);
            if (!element) {
              logger.warn(`Element ${id} not found on canvas, skipping ungroup`);
              return null;
            }

            // Remove only the specific groupId, preserve others
            const updatedGroupIds = (element.groupIds || []).filter(gid => gid !== groupId);
            return await updateElementOnCanvas({ id, groupIds: updatedGroupIds });
          });

          const results = await Promise.all(updatePromises);
          const successCount = results.filter(result => result !== null).length;

          if (successCount === 0) {
            throw new Error('Failed to ungroup: no elements were updated (elements may not exist on canvas)');
          }

          logger.info('Ungrouping elements', { groupId, elementIds, successCount });

          const result = { groupId, ungrouped: true, elementIds, successCount };
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
          };
        } catch (error) {
          throw new Error(`Failed to ungroup elements: ${(error as Error).message}`);
        }
      }
      
      case 'align_elements': {
        const params = AlignElementsSchema.parse(args);
        const { elementIds, alignment } = params;
        logger.info('Aligning elements', { elementIds, alignment });

        // Fetch all elements
        const elementsToAlign: ServerElement[] = [];
        for (const id of elementIds) {
          const el = await getElementFromCanvas(id);
          if (el) elementsToAlign.push(el);
        }
        startAgentActivity('align_elements', {
          elements: elementsToAlign,
          elementIds
        });

        if (elementsToAlign.length < 2) {
          throw new Error('Need at least 2 elements to align');
        }

        // Calculate alignment target
        let updateFn: (el: ServerElement) => { x?: number; y?: number };
        switch (alignment) {
          case 'left': {
            const minX = Math.min(...elementsToAlign.map(el => el.x));
            updateFn = () => ({ x: minX });
            break;
          }
          case 'right': {
            const maxRight = Math.max(...elementsToAlign.map(el => el.x + (el.width || 0)));
            updateFn = (el) => ({ x: maxRight - (el.width || 0) });
            break;
          }
          case 'center': {
            const centers = elementsToAlign.map(el => el.x + (el.width || 0) / 2);
            const avgCenter = centers.reduce((a, b) => a + b, 0) / centers.length;
            updateFn = (el) => ({ x: avgCenter - (el.width || 0) / 2 });
            break;
          }
          case 'top': {
            const minY = Math.min(...elementsToAlign.map(el => el.y));
            updateFn = () => ({ y: minY });
            break;
          }
          case 'bottom': {
            const maxBottom = Math.max(...elementsToAlign.map(el => el.y + (el.height || 0)));
            updateFn = (el) => ({ y: maxBottom - (el.height || 0) });
            break;
          }
          case 'middle': {
            const middles = elementsToAlign.map(el => el.y + (el.height || 0) / 2);
            const avgMiddle = middles.reduce((a, b) => a + b, 0) / middles.length;
            updateFn = (el) => ({ y: avgMiddle - (el.height || 0) / 2 });
            break;
          }
        }

        // Apply updates
        const updatePromises = elementsToAlign.map(async (el) => {
          const coords = updateFn(el);
          return await updateElementOnCanvas({ id: el.id, ...coords });
        });
        const results = await Promise.all(updatePromises);
        const successCount = results.filter(r => r).length;

        if (successCount === 0) {
          throw new Error('Failed to align any elements: HTTP server unavailable');
        }

        const result = { aligned: true, elementIds, alignment, successCount };
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      }
      
      case 'distribute_elements': {
        const params = DistributeElementsSchema.parse(args);
        const { elementIds, direction } = params;
        logger.info('Distributing elements', { elementIds, direction });

        // Fetch all elements
        const elementsToDist: ServerElement[] = [];
        for (const id of elementIds) {
          const el = await getElementFromCanvas(id);
          if (el) elementsToDist.push(el);
        }
        startAgentActivity('distribute_elements', {
          elements: elementsToDist,
          elementIds
        });

        if (elementsToDist.length < 3) {
          throw new Error('Need at least 3 elements to distribute');
        }

        if (direction === 'horizontal') {
          // Sort by x position
          elementsToDist.sort((a, b) => a.x - b.x);
          const first = elementsToDist[0]!;
          const last = elementsToDist[elementsToDist.length - 1]!;
          const totalSpan = (last.x + (last.width || 0)) - first.x;
          const totalElementWidth = elementsToDist.reduce((sum, el) => sum + (el.width || 0), 0);
          const gap = (totalSpan - totalElementWidth) / (elementsToDist.length - 1);

          let currentX = first.x;
          for (const el of elementsToDist) {
            await updateElementOnCanvas({ id: el.id, x: currentX });
            currentX += (el.width || 0) + gap;
          }
        } else {
          // Sort by y position
          elementsToDist.sort((a, b) => a.y - b.y);
          const first = elementsToDist[0]!;
          const last = elementsToDist[elementsToDist.length - 1]!;
          const totalSpan = (last.y + (last.height || 0)) - first.y;
          const totalElementHeight = elementsToDist.reduce((sum, el) => sum + (el.height || 0), 0);
          const gap = (totalSpan - totalElementHeight) / (elementsToDist.length - 1);

          let currentY = first.y;
          for (const el of elementsToDist) {
            await updateElementOnCanvas({ id: el.id, y: currentY });
            currentY += (el.height || 0) + gap;
          }
        }

        const result = { distributed: true, elementIds, direction, count: elementsToDist.length };
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      }
      
      case 'lock_elements': {
        const params = ElementIdsSchema.parse(args);
        const { elementIds } = params;
        
        try {
          startAgentActivity('lock_elements', {
            elements: await getElementsFromCanvas(elementIds),
            elementIds
          });

          // Lock elements through HTTP API updates
          const updatePromises = elementIds.map(async (id) => {
            return await updateElementOnCanvas({ id, locked: true });
          });
          
          const results = await Promise.all(updatePromises);
          const successCount = results.filter(result => result).length;
          
          if (successCount === 0) {
            throw new Error('Failed to lock any elements: HTTP server unavailable');
          }
          
          const result = { locked: true, elementIds, successCount };
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
          };
        } catch (error) {
          throw new Error(`Failed to lock elements: ${(error as Error).message}`);
        }
      }
      
      case 'unlock_elements': {
        const params = ElementIdsSchema.parse(args);
        const { elementIds } = params;
        
        try {
          startAgentActivity('unlock_elements', {
            elements: await getElementsFromCanvas(elementIds),
            elementIds
          });

          // Unlock elements through HTTP API updates
          const updatePromises = elementIds.map(async (id) => {
            return await updateElementOnCanvas({ id, locked: false });
          });
          
          const results = await Promise.all(updatePromises);
          const successCount = results.filter(result => result).length;
          
          if (successCount === 0) {
            throw new Error('Failed to unlock any elements: HTTP server unavailable');
          }
          
          const result = { unlocked: true, elementIds, successCount };
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
          };
        } catch (error) {
          throw new Error(`Failed to unlock elements: ${(error as Error).message}`);
        }
      }
      
      case 'create_from_mermaid': {
        const params = z.object({
          mermaidDiagram: z.string(),
          config: z.object({
            startOnLoad: z.boolean().optional(),
            flowchart: z.object({
              curve: z.enum(['linear', 'basis']).optional()
            }).optional(),
            themeVariables: z.object({
              fontSize: z.string().optional()
            }).optional(),
            maxEdges: z.number().optional(),
            maxTextSize: z.number().optional()
          }).optional()
        }).parse(args);
        
        logger.info('Creating Excalidraw elements from Mermaid diagram via MCP', {
          diagramLength: params.mermaidDiagram.length,
          hasConfig: !!params.config
        });
        startAgentActivity('create_from_mermaid', {
          point: { x: sceneState.viewport.x, y: sceneState.viewport.y }
        });

        try {
          // Send the Mermaid diagram to the frontend via the API
          // The frontend will use mermaid-to-excalidraw to convert it
          const response = await fetch(`${API_BASE}/elements/from-mermaid`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              mermaidDiagram: params.mermaidDiagram,
              config: params.config
            })
          });

          if (!response.ok) {
            throw new Error(`HTTP server error: ${response.status} ${response.statusText}`);
          }

          const result = await response.json() as ApiResponse;
          
          logger.info('Mermaid diagram sent to frontend for conversion', {
            success: result.success
          });

          return {
            content: [{
              type: 'text',
              text: `Mermaid diagram sent for conversion!\n\n${JSON.stringify(result, null, 2)}\n\nNote: The actual conversion happens in the frontend canvas with DOM access. Open ${ROOM_URL} to see the diagram rendered.`
            }]
          };
        } catch (error) {
          throw new Error(`Failed to process Mermaid diagram: ${(error as Error).message}`);
        }
      }
      
      case 'batch_create_elements': {
        const params = z.object({ elements: z.array(ElementSchema) }).parse(args);
        logger.info('Batch creating elements via MCP', { count: params.elements.length });

        const createdElements: ServerElement[] = [];

        for (const elementData of params.elements) {
          const { startElementId, endElementId, id: customId, ...elementProps } = elementData;
          const id = customId || generateId();
          const element: ServerElement = {
            id,
            ...elementProps,
            points: elementProps.points ? normalizePoints(elementProps.points) : undefined,
            // Convert binding IDs to Excalidraw's start/end format
            ...(startElementId ? { start: { id: startElementId } } : {}),
            ...(endElementId ? { end: { id: endElementId } } : {}),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            version: 1
          };

          // Normalize fontFamily from string names to numeric values
          if (element.fontFamily !== undefined) {
            element.fontFamily = normalizeFontFamily(element.fontFamily);
          }

          // For bound arrows without explicit points, set a default
          if ((startElementId || endElementId) && !elementProps.points) {
            (element as any).points = [[0, 0], [100, 0]];
          }

          const excalidrawElement = convertTextToLabel(element);
          createdElements.push(excalidrawElement);
        }

        startAgentActivity('batch_create_elements', {
          elements: createdElements,
          elementIds: createdElements.map(element => element.id)
        });

        const canvasElements = await batchCreateElementsOnCanvas(createdElements);

        if (!canvasElements) {
          throw new Error('Failed to batch create elements: HTTP server unavailable');
        }

        const result = {
          success: true,
          elements: canvasElements,
          count: canvasElements.length,
          syncedToCanvas: true
        };

        logger.info('Batch elements created via MCP and synced to canvas', {
          count: result.count,
          synced: result.syncedToCanvas
        });

        return {
          content: [{
            type: 'text',
            text: `${result.count} elements created successfully!\n\n${JSON.stringify(result, null, 2)}\n\n${result.syncedToCanvas ? '✅ All elements synced to canvas' : '⚠️  Canvas sync failed (elements still created locally)'}`
          }]
        };
      }

      case 'get_element': {
        const params = ElementIdSchema.parse(args);
        const { id } = params;

        const element = await getElementFromCanvas(id);
        if (!element) {
          throw new Error(`Element ${id} not found`);
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(element, null, 2) }]
        };
      }

      case 'clear_canvas': {
        logger.info('Clearing canvas via MCP');
        const existingElementsResponse = await fetch(`${API_BASE}/elements`);
        if (existingElementsResponse.ok) {
          const existingData = await existingElementsResponse.json() as ApiResponse;
          startAgentActivity('clear_canvas', {
            elements: existingData.elements || [],
            elementIds: (existingData.elements || []).map(element => element.id)
          });
        } else {
          startAgentActivity('clear_canvas');
        }

        const response = await fetch(`${API_BASE}/elements/clear`, {
          method: 'DELETE'
        });

        if (!response.ok) {
          throw new Error(`Failed to clear canvas: ${response.status} ${response.statusText}`);
        }

        const data = await response.json() as ApiResponse;

        return {
          content: [{
            type: 'text',
            text: `Canvas cleared.\n\n${JSON.stringify(data, null, 2)}`
          }]
        };
      }

      case 'export_scene': {
        const params = z.object({
          filePath: z.string().optional()
        }).parse(args || {});

        logger.info('Exporting scene via MCP');

        const response = await fetch(`${API_BASE}/elements`);
        if (!response.ok) {
          throw new Error(`Failed to fetch elements: ${response.status} ${response.statusText}`);
        }

        const data = await response.json() as ApiResponse;
        const sceneElements = data.elements || [];

        // Fetch files for image elements
        let sceneFiles: Record<string, any> = {};
        try {
          const filesResponse = await fetch(`${API_BASE}/files`);
          if (filesResponse.ok) {
            const filesData = await filesResponse.json() as any;
            sceneFiles = filesData.files || {};
          }
        } catch { /* files endpoint may not exist */ }

        const excalidrawScene: any = {
          type: 'excalidraw',
          version: 2,
          source: 'mcp-excalidraw-server',
          elements: sceneElements,
          appState: {
            viewBackgroundColor: '#ffffff',
            gridSize: null
          },
          ...(Object.keys(sceneFiles).length > 0 ? { files: sceneFiles } : {})
        };

        const jsonString = JSON.stringify(excalidrawScene, null, 2);

        if (params.filePath) {
          const safePath = sanitizeFilePath(params.filePath);
          fs.writeFileSync(safePath, jsonString, 'utf-8');
          return {
            content: [{
              type: 'text',
              text: `Scene exported to ${safePath} (${sceneElements.length} elements)`
            }]
          };
        }

        return {
          content: [{
            type: 'text',
            text: jsonString
          }]
        };
      }

      case 'import_scene': {
        const params = z.object({
          filePath: z.string().optional(),
          data: z.string().optional(),
          mode: z.enum(['replace', 'merge'])
        }).parse(args);

        logger.info('Importing scene via MCP', { mode: params.mode });

        let sceneData: any;
        if (params.filePath) {
          const safeImportPath = sanitizeFilePath(params.filePath);
          const fileContent = fs.readFileSync(safeImportPath, 'utf-8');
          sceneData = JSON.parse(fileContent);
        } else if (params.data) {
          sceneData = JSON.parse(params.data);
        } else {
          throw new Error('Either filePath or data must be provided');
        }

        // Extract elements from .excalidraw format or raw array
        const importElements: ServerElement[] = Array.isArray(sceneData)
          ? sceneData
          : (sceneData.elements || []);

        if (importElements.length === 0) {
          throw new Error('No elements found in the import data');
        }

        const elementsToImport: ServerElement[] = importElements.map(el => ({
          ...el,
          id: el.id || generateId(),
          createdAt: el.createdAt || new Date().toISOString(),
          updatedAt: el.updatedAt || new Date().toISOString(),
          version: typeof el.version === 'number' ? el.version : 1
        } as ServerElement));
        startAgentActivity('import_scene', {
          elements: elementsToImport,
          elementIds: elementsToImport.map(element => element.id)
        });

        let elementsToSync: ServerElement[] = elementsToImport;
        if (params.mode === 'merge') {
          const existingResponse = await fetch(`${API_BASE}/elements`);
          if (existingResponse.ok) {
            const existingData = await existingResponse.json() as ApiResponse;
            elementsToSync = [...(existingData.elements || []), ...elementsToImport];
          }
        }

        const syncResponse = await fetch(`${API_BASE}/elements/sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientId: MCP_CLIENT_ID,
            traceId: `${MCP_CLIENT_ID}:import_scene:${Date.now().toString(36)}`,
            replace: params.mode === 'replace',
            elements: elementsToSync,
            timestamp: new Date().toISOString()
          })
        });

        if (!syncResponse.ok) {
          const errorText = await syncResponse.text();
          throw new Error(`Failed to import scene: ${syncResponse.status} ${syncResponse.statusText} ${errorText}`);
        }

        // Import files if present (for image elements)
        let importedFileCount = 0;
        const importFiles = sceneData.files;
        if (importFiles && typeof importFiles === 'object') {
          const fileList = Object.values(importFiles);
          if (fileList.length > 0) {
            try {
              await fetch(`${API_BASE}/files`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(fileList)
              });
              importedFileCount = fileList.length;
            } catch { /* best effort */ }
          }
        }

        return {
          content: [{
            type: 'text',
            text: `Imported ${elementsToImport.length} elements${importedFileCount > 0 ? ` and ${importedFileCount} files` : ''} (mode: ${params.mode})\n\n✅ Synced full scene data to canvas`
          }]
        };
      }

      case 'export_to_image': {
        const params = z.object({
          format: z.enum(['png', 'svg']),
          filePath: z.string().optional(),
          background: z.boolean().optional()
        }).parse(args);

        logger.info('Exporting to image via MCP', { format: params.format });

        const response = await fetchOrThrow(`${API_BASE}/export/image`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            format: params.format,
            background: params.background ?? true
          })
        });

        const result = await response.json() as { success: boolean; format: string; data: string };

        if (params.filePath) {
          const safeImagePath = sanitizeFilePath(params.filePath);
          if (params.format === 'svg') {
            fs.writeFileSync(safeImagePath, result.data, 'utf-8');
          } else {
            fs.writeFileSync(safeImagePath, Buffer.from(result.data, 'base64'));
          }
          return {
            content: [{
              type: 'text',
              text: `Image exported to ${safeImagePath} (format: ${params.format})`
            }]
          };
        }

        return {
          content: [{
            type: 'text',
            text: params.format === 'svg'
              ? result.data
              : `Base64 ${params.format} data (${result.data.length} chars). Use filePath to save to disk.`
          }]
        };
      }

      case 'duplicate_elements': {
        const params = z.object({
          elementIds: z.array(z.string()),
          offsetX: z.number().optional(),
          offsetY: z.number().optional()
        }).parse(args);

        const offsetX = params.offsetX ?? 20;
        const offsetY = params.offsetY ?? 20;

        logger.info('Duplicating elements via MCP', { count: params.elementIds.length });

        const duplicates: ServerElement[] = [];
        for (const id of params.elementIds) {
          const original = await getElementFromCanvas(id);
          if (!original) {
            logger.warn(`Element ${id} not found, skipping duplicate`);
            continue;
          }

          const { createdAt, updatedAt, version, syncedAt, source, syncTimestamp, ...rest } = original;
          const duplicate: ServerElement = {
            ...rest,
            id: generateId(),
            x: original.x + offsetX,
            y: original.y + offsetY,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            version: 1
          };
          duplicates.push(duplicate);
        }

        if (duplicates.length === 0) {
          throw new Error('No elements could be duplicated (none found)');
        }

        startAgentActivity('duplicate_elements', {
          elements: duplicates,
          elementIds: duplicates.map(element => element.id)
        });

        const canvasElements = await batchCreateElementsOnCanvas(duplicates);

        return {
          content: [{
            type: 'text',
            text: `Duplicated ${duplicates.length} elements (offset: ${offsetX}, ${offsetY})\n\n${JSON.stringify(canvasElements, null, 2)}\n\n✅ Synced to canvas`
          }]
        };
      }

      case 'snapshot_scene': {
        const params = z.object({ name: z.string() }).parse(args);
        logger.info('Saving snapshot via MCP', { name: params.name });

        const response = await fetch(`${API_BASE}/snapshots`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: params.name })
        });

        if (!response.ok) {
          throw new Error(`Failed to save snapshot: ${response.status} ${response.statusText}`);
        }

        const result = await response.json() as any;

        return {
          content: [{
            type: 'text',
            text: `Snapshot "${params.name}" saved (${result.elementCount} elements)\n\n${JSON.stringify(result, null, 2)}`
          }]
        };
      }

      case 'restore_snapshot': {
        const params = z.object({ name: z.string() }).parse(args);
        logger.info('Restoring snapshot via MCP', { name: params.name });

        // Fetch the snapshot
        const response = await fetch(`${API_BASE}/snapshots/${encodeURIComponent(params.name)}`);
        if (!response.ok) {
          throw new Error(`Snapshot "${params.name}" not found`);
        }

        const data = await response.json() as { success: boolean; snapshot: { name: string; elements: ServerElement[]; createdAt: string } };
        startAgentActivity('restore_snapshot', {
          elements: data.snapshot.elements,
          elementIds: data.snapshot.elements.map(element => element.id)
        });

        // Clear current canvas
        await fetch(`${API_BASE}/elements/clear`, { method: 'DELETE' });

        // Restore elements
        const canvasElements = await batchCreateElementsOnCanvas(data.snapshot.elements);

        return {
          content: [{
            type: 'text',
            text: `Snapshot "${params.name}" restored (${data.snapshot.elements.length} elements)\n\n✅ Canvas updated`
          }]
        };
      }

      case 'describe_scene': {
        const { filePath, ...params } = DescribeSceneSchema.parse(args || {});
        logger.info('Describing scene via MCP', params);

        const response = await fetch(`${API_BASE}/elements`);
        if (!response.ok) {
          throw new Error(`Failed to fetch elements: ${response.status}`);
        }

        const data = await response.json() as ApiResponse;
        const allElements = data.elements || [];
        const description = buildSceneDescription(allElements, params);

        if (filePath) {
          const safePath = sanitizeFilePath(filePath);
          fs.writeFileSync(safePath, description, 'utf-8');
          return {
            content: [{
              type: 'text',
              text: `Scene description written to ${safePath} (${description.length} chars)`
            }]
          };
        }

        return {
          content: [{ type: 'text', text: description }]
        };
      }

      case 'get_canvas_screenshot': {
        const params = z.object({
          background: z.boolean().optional(),
          filePath: z.string().optional()
        }).parse(args || {});

        logger.info('Taking canvas screenshot via MCP');

        const response = await fetchOrThrow(`${API_BASE}/export/image`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            format: 'png',
            background: params.background ?? true
          })
        });

        const result = await response.json() as { success: boolean; format: string; data: string };

        if (params.filePath) {
          const safePath = sanitizeFilePath(params.filePath);
          fs.writeFileSync(safePath, Buffer.from(result.data, 'base64'));
          return {
            content: [{
              type: 'text',
              text: `Canvas screenshot saved to ${safePath}`
            }]
          };
        }

        return {
          content: [
            {
              type: 'image' as const,
              data: result.data,
              mimeType: 'image/png'
            },
            {
              type: 'text',
              text: 'Canvas screenshot captured. This is what the diagram currently looks like.'
            }
          ]
        };
      }

      case 'read_diagram_guide': {
        return {
          content: [{ type: 'text', text: DIAGRAM_DESIGN_GUIDE }]
        };
      }

      case 'export_to_excalidraw_url': {
        logger.info('Exporting to excalidraw.com URL');

        // 1. Fetch current scene elements
        const urlExportResponse = await fetch(`${API_BASE}/elements`);
        if (!urlExportResponse.ok) {
          throw new Error(`Failed to fetch elements: ${urlExportResponse.status}`);
        }
        const urlExportData = await urlExportResponse.json() as ApiResponse;
        const urlExportElements = urlExportData.elements || [];

        if (urlExportElements.length === 0) {
          throw new Error('Canvas is empty — nothing to export');
        }

        // 2. Clean elements: strip server metadata, add Excalidraw defaults,
        // generate bound text elements, and resolve arrow bindings
        const cleanedExportElements: Record<string, any>[] = [];
        const boundTextElements: Record<string, any>[] = [];
        let indexCounter = 0;

        function makeBaseElement(el: any, rest: any): Record<string, any> {
          return {
            ...rest,
            angle: rest.angle ?? 0,
            strokeColor: rest.strokeColor ?? '#1e1e1e',
            backgroundColor: rest.backgroundColor ?? 'transparent',
            fillStyle: rest.fillStyle ?? 'solid',
            strokeWidth: rest.strokeWidth ?? 2,
            strokeStyle: rest.strokeStyle ?? 'solid',
            roughness: rest.roughness ?? 1,
            opacity: rest.opacity ?? 100,
            groupIds: rest.groupIds ?? [],
            frameId: rest.frameId ?? null,
            index: rest.index ?? `a${indexCounter++}`,
            roundness: rest.roundness ?? (
              el.type === 'rectangle' || el.type === 'diamond' || el.type === 'ellipse'
                ? { type: 3 } : null
            ),
            seed: rest.seed ?? Math.floor(Math.random() * 2147483647),
            version: rest.version ?? 1,
            versionNonce: rest.versionNonce ?? Math.floor(Math.random() * 2147483647),
            isDeleted: false,
            boundElements: rest.boundElements ?? null,
            updated: Date.now(),
            link: rest.link ?? null,
            locked: rest.locked ?? false
          };
        }

        for (const el of urlExportElements) {
          // Strip server-only fields
          const {
            createdAt, updatedAt, syncedAt, source: _src,
            syncTimestamp, label, start, end, text,
            version: _ver,
            ...rest
          } = el as any;

          const base = makeBaseElement(el, rest);

          // Standalone text elements: keep text directly
          if (el.type === 'text') {
            base.text = text ?? '';
            base.originalText = text ?? '';
            base.fontSize = rest.fontSize ?? 20;
            base.fontFamily = normalizeFontFamily(rest.fontFamily) ?? 1;
            base.textAlign = rest.textAlign ?? 'center';
            base.verticalAlign = rest.verticalAlign ?? 'middle';
            base.autoResize = rest.autoResize ?? true;
            base.lineHeight = rest.lineHeight ?? 1.25;
            base.containerId = rest.containerId ?? null;
            cleanedExportElements.push(base);
            continue;
          }

          // Arrows: server already resolved bindings (start/end → startBinding/endBinding + positions)
          if (el.type === 'arrow' || el.type === 'line') {
            base.points = rest.points ?? [[0, 0], [100, 0]];
            base.lastCommittedPoint = null;
            // Preserve server-resolved bindings with fixedPoint for excalidraw.com
            if (rest.startBinding) {
              base.startBinding = { ...rest.startBinding, fixedPoint: rest.startBinding.fixedPoint ?? null };
            } else {
              base.startBinding = null;
            }
            if (rest.endBinding) {
              base.endBinding = { ...rest.endBinding, fixedPoint: rest.endBinding.fixedPoint ?? null };
            } else {
              base.endBinding = null;
            }
            base.startArrowhead = rest.startArrowhead ?? null;
            base.endArrowhead = rest.endArrowhead ?? (el.type === 'arrow' ? 'arrow' : null);
            base.elbowed = rest.elbowed ?? false;
          }

          // Generate bound text element for label on shapes and arrows
          const labelText = label?.text || text;
          if (labelText) {
            const textId = `${base.id}-label`;
            // Add binding reference to parent
            base.boundElements = [
              ...(Array.isArray(base.boundElements) ? base.boundElements : []),
              { type: 'text', id: textId }
            ];

            // Compute text position: centered in shape, or at arrow midpoint
            let textX: number, textY: number, textW: number, textH: number;
            const isArrow = el.type === 'arrow' || el.type === 'line';

            if (isArrow) {
              // Position at midpoint of arrow path
              const pts = base.points || [[0, 0], [100, 0]];
              const lastPt = pts[pts.length - 1];
              const midX = base.x + (lastPt[0] / 2);
              const midY = base.y + (lastPt[1] / 2);
              const labelW = Math.max(labelText.length * 10, 60);
              textX = midX - labelW / 2;
              textY = midY - 12;
              textW = labelW;
              textH = 24;
            } else {
              // Center inside shape container
              const containerW = base.width ?? 160;
              const containerH = base.height ?? 80;
              textX = base.x + 10;
              textY = base.y + containerH / 4;
              textW = containerW - 20;
              textH = containerH / 2;
            }

            boundTextElements.push({
              id: textId,
              type: 'text',
              x: textX,
              y: textY,
              width: textW,
              height: textH,
              angle: 0,
              strokeColor: isArrow ? '#1e1e1e' : base.strokeColor,
              backgroundColor: 'transparent',
              fillStyle: 'solid',
              strokeWidth: 1,
              strokeStyle: 'solid',
              roughness: 1,
              opacity: 100,
              groupIds: [],
              frameId: null,
              index: `a${indexCounter++}`,
              roundness: null,
              seed: Math.floor(Math.random() * 2147483647),
              version: 1,
              versionNonce: Math.floor(Math.random() * 2147483647),
              isDeleted: false,
              boundElements: null,
              updated: Date.now(),
              link: null,
              locked: false,
              text: labelText,
              originalText: labelText,
              fontSize: isArrow ? 14 : (rest.fontSize ?? 16),
              fontFamily: normalizeFontFamily(rest.fontFamily) ?? 1,
              textAlign: 'center',
              verticalAlign: 'middle',
              autoResize: true,
              lineHeight: 1.25,
              containerId: base.id
            });
          }

          cleanedExportElements.push(base);
        }

        // Patch shapes' boundElements to include connected arrows
        const shapeBoundArrows = new Map<string, { type: string; id: string }[]>();
        for (const el of cleanedExportElements) {
          if (el.startBinding?.elementId) {
            const arr = shapeBoundArrows.get(el.startBinding.elementId) || [];
            arr.push({ type: 'arrow', id: el.id });
            shapeBoundArrows.set(el.startBinding.elementId, arr);
          }
          if (el.endBinding?.elementId) {
            const arr = shapeBoundArrows.get(el.endBinding.elementId) || [];
            arr.push({ type: 'arrow', id: el.id });
            shapeBoundArrows.set(el.endBinding.elementId, arr);
          }
        }
        for (const el of cleanedExportElements) {
          const arrowBindings = shapeBoundArrows.get(el.id);
          if (arrowBindings) {
            el.boundElements = [
              ...(Array.isArray(el.boundElements) ? el.boundElements : []),
              ...arrowBindings
            ];
          }
        }

        // Append all bound text elements after their parents
        cleanedExportElements.push(...boundTextElements);

        // Build .excalidraw scene JSON
        const excalidrawScene = {
          type: 'excalidraw',
          version: 2,
          source: 'https://excalidraw.com',
          elements: cleanedExportElements,
          appState: {
            viewBackgroundColor: '#ffffff',
            gridSize: null
          },
          files: {}
        };
        const sceneJson = JSON.stringify(excalidrawScene);
        const dataBytes = new TextEncoder().encode(sceneJson);

        // Excalidraw's concatBuffers: [4-byte version=1][4-byte len][chunk]...
        function concatBuffers(...bufs: Uint8Array[]): Uint8Array {
          let total = 4; // version header
          for (const b of bufs) total += 4 + b.length;
          const out = new Uint8Array(total);
          const dv = new DataView(out.buffer);
          dv.setUint32(0, 1); // CONCAT_BUFFERS_VERSION = 1
          let off = 4;
          for (const b of bufs) {
            dv.setUint32(off, b.length);
            off += 4;
            out.set(b, off);
            off += b.length;
          }
          return out;
        }

        const encoder = new TextEncoder();

        // 3. Inner data: concatBuffers(fileMetadata, dataJSON)
        const fileMetadata = encoder.encode('{}');
        const innerData = concatBuffers(fileMetadata, dataBytes);

        // 4. Compress with zlib deflate
        const compressed = deflateSync(Buffer.from(innerData));

        // 5. Encrypt with AES-GCM 128-bit key
        const cryptoKey = await webcrypto.subtle.generateKey(
          { name: 'AES-GCM', length: 128 },
          true,
          ['encrypt']
        );

        const iv = webcrypto.getRandomValues(new Uint8Array(12));
        const encrypted = await webcrypto.subtle.encrypt(
          { name: 'AES-GCM', iv },
          cryptoKey,
          compressed
        );

        // 6. Outer payload: concatBuffers(encodingMeta, iv, ciphertext)
        const encodingMeta = encoder.encode(JSON.stringify({
          version: 2,
          compression: 'pako@1',
          encryption: 'AES-GCM'
        }));
        const ciphertext = new Uint8Array(encrypted);
        const payload = concatBuffers(encodingMeta, iv, ciphertext);

        // 7. POST to excalidraw.com JSON store
        const uploadResponse = await fetch('https://json.excalidraw.com/api/v2/post/', {
          method: 'POST',
          body: Buffer.from(payload)
        });

        if (!uploadResponse.ok) {
          throw new Error(`Upload to excalidraw.com failed: ${uploadResponse.status} ${uploadResponse.statusText}`);
        }

        const uploadResult = await uploadResponse.json() as { id: string };

        // 8. Export key as JWK to get the "k" field
        const jwk = await webcrypto.subtle.exportKey('jwk', cryptoKey);

        // 9. Build shareable URL
        const shareUrl = `https://excalidraw.com/#json=${uploadResult.id},${jwk.k}`;

        return {
          content: [{
            type: 'text',
            text: `Diagram exported to excalidraw.com!\n\nShareable URL: ${shareUrl}\n\nAnyone with this link can view and edit the diagram.`
          }]
        };
      }

      case 'set_viewport': {
        const viewportParams = z.object({
          scrollToContent: z.boolean().optional(),
          scrollToElementId: z.string().optional(),
          zoom: z.number().min(0.1).max(10).optional(),
          offsetX: z.number().optional(),
          offsetY: z.number().optional()
        }).parse(args || {});

        logger.info('Setting viewport via MCP', viewportParams);

        const viewportResponse = await fetch(`${API_BASE}/viewport`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(viewportParams)
        });

        if (!viewportResponse.ok) {
          const viewportError = await viewportResponse.json() as ApiResponse;
          throw new Error(viewportError.error || `Viewport request failed: ${viewportResponse.status}`);
        }

        const viewportResult = await viewportResponse.json() as { success: boolean; message?: string };

        return {
          content: [{
            type: 'text',
            text: `Viewport updated successfully.\n\n${JSON.stringify(viewportResult, null, 2)}`
          }]
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    logger.error(`Error handling tool call: ${(error as Error).message}`, { error });
    return {
      content: [{ type: 'text', text: `Error in tool "${name}": ${formatToolError(error)}` }],
      isError: true
    };
  } finally {
    if (shouldFinishAgentActivity) {
      agentPresence.finishActivity();
    }
  }
  };

  return roomContext ? roomContextStorage.run(roomContext, runTool) : runTool();
};

// Set up request handler for listing available tools
const listToolsHandler = async () => {
  logger.info('Listing available tools');
  return { tools };
};

// Module-level Server instance for stdio mode. The HTTP /mcp endpoint
// calls buildMcpServer() per session instead.
const server = buildMcpServer();

// Start server
async function runServer(): Promise<void> {
  // Wrap the entire event loop in one session scope so all stdio handlers
  // see the same currentRoom state. Avoids each request entering its own
  // empty session via the late-bound fallback.
  return mcpSessionStorage.run({ currentRoom: null }, async () => {
    try {
      logger.info('Starting Excalidraw MCP server...');

      const transport = new StdioServerTransport();
      logger.debug('Connecting to stdio transport...');

      await server.connect(transport);
      logger.info('Excalidraw MCP server running on stdio');

      process.stdin.resume();
    } catch (error) {
      logger.error('Error starting server:', error);
      process.stderr.write(`Failed to start MCP server: ${(error as Error).message}\n${(error as Error).stack}\n`);
      process.exit(1);
    }
  });
}

// Add global error handlers
process.on('uncaughtException', (error: Error) => {
  agentPresence.disconnect();
  logger.error('Uncaught exception:', error);
  process.stderr.write(`UNCAUGHT EXCEPTION: ${error.message}\n${error.stack}\n`);
  setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
  agentPresence.disconnect();
  logger.error('Unhandled promise rejection:', reason);
  process.stderr.write(`UNHANDLED REJECTION: ${reason}\n`);
  setTimeout(() => process.exit(1), 1000);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    agentPresence.disconnect();
    setTimeout(() => process.exit(0), 50);
  });
}

// For testing and debugging purposes
if (process.env.DEBUG === 'true') {
  logger.debug('Debug mode enabled');
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }

  return undefined;
}

function resolveEntrypointPath(filePath: string | undefined): string | null {
  if (!filePath) return null;

  try {
    return fs.realpathSync(filePath);
  } catch (error) {
    const code = getErrorCode(error);
    if (code !== 'ENOENT') {
      logger.warn(`fs.realpathSync failed for "${filePath}", falling back to path.resolve.`, {
        code,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return path.resolve(filePath);
  }
}

// Start the server if this file is run directly.
// npm/npx commonly invoke package bins through symlinks; compare real paths so
// the stdio transport still starts from those standard install paths.
if (resolveEntrypointPath(fileURLToPath(import.meta.url)) === resolveEntrypointPath(process.argv[1])) {
  runServer().catch(error => {
    logger.error('Failed to start server:', error);
    process.exit(1);
  });
}

export default runServer;
