import fs from 'fs';
import path from 'path';
import logger from './utils/logger.js';
import {
  elements,
  files,
  snapshots,
  roomsMeta,
  ensureRoom,
  RoomMeta,
  ServerElement,
  ExcalidrawFile,
  Snapshot,
} from './types.js';

const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
const DEBOUNCE_MS = parseInt(process.env.PERSIST_DEBOUNCE_MS || '1000', 10);

interface PersistedRoom {
  meta: RoomMeta;
  elements: ServerElement[];
  files: ExcalidrawFile[];
  snapshots: Snapshot[];
}

const dirtyRooms = new Set<string>();
const pendingTimers = new Map<string, NodeJS.Timeout>();

function ensureDataDir(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function roomFile(roomId: string): string {
  return path.join(DATA_DIR, `${roomId}.json`);
}

function serializeRoom(roomId: string): PersistedRoom | null {
  const meta = roomsMeta.get(roomId);
  if (!meta) return null;
  return {
    meta,
    elements: Array.from((elements.get(roomId) || new Map()).values()),
    files: Array.from((files.get(roomId) || new Map()).values()),
    snapshots: Array.from((snapshots.get(roomId) || new Map()).values()),
  };
}

function writeRoomSync(roomId: string): void {
  const data = serializeRoom(roomId);
  if (!data) {
    // Room was deleted: remove the file too
    const target = roomFile(roomId);
    if (fs.existsSync(target)) {
      try { fs.unlinkSync(target); } catch (err) { logger.warn(`Failed to unlink ${target}:`, err); }
    }
    return;
  }
  const target = roomFile(roomId);
  const tmp = `${target}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf-8');
    fs.renameSync(tmp, target);
  } catch (err) {
    logger.error(`Failed to persist room ${roomId}:`, err);
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
  }
}

export function markDirty(roomId: string): void {
  dirtyRooms.add(roomId);
  const existing = pendingTimers.get(roomId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingTimers.delete(roomId);
    if (!dirtyRooms.has(roomId)) return;
    dirtyRooms.delete(roomId);
    writeRoomSync(roomId);
  }, DEBOUNCE_MS);
  // Don't keep the event loop alive for pending writes alone.
  if (typeof timer.unref === 'function') timer.unref();
  pendingTimers.set(roomId, timer);
}

export function flushAll(): void {
  for (const timer of pendingTimers.values()) clearTimeout(timer);
  pendingTimers.clear();
  const ids = new Set<string>([...dirtyRooms, ...roomsMeta.keys()]);
  // Also flush any rooms whose files exist but were deleted in-memory
  try {
    for (const f of fs.readdirSync(DATA_DIR)) {
      if (f.endsWith('.json')) ids.add(f.replace(/\.json$/, ''));
    }
  } catch {}
  for (const id of ids) writeRoomSync(id);
  dirtyRooms.clear();
}

export function deleteRoomFile(roomId: string): void {
  const target = roomFile(roomId);
  if (fs.existsSync(target)) {
    try { fs.unlinkSync(target); } catch (err) { logger.warn(`Failed to delete room file ${target}:`, err); }
  }
  const pending = pendingTimers.get(roomId);
  if (pending) { clearTimeout(pending); pendingTimers.delete(roomId); }
  dirtyRooms.delete(roomId);
}

export function loadAll(): void {
  ensureDataDir();
  let loaded = 0;
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (!f.endsWith('.json')) continue;
    const fullPath = path.join(DATA_DIR, f);
    try {
      const raw = fs.readFileSync(fullPath, 'utf-8');
      const parsed = JSON.parse(raw) as PersistedRoom;
      if (!parsed?.meta?.id) {
        logger.warn(`Skipping ${f}: no meta.id`);
        continue;
      }
      const id = parsed.meta.id;
      ensureRoom(id, parsed.meta.name);
      const meta = roomsMeta.get(id)!;
      meta.createdAt = parsed.meta.createdAt || meta.createdAt;
      meta.updatedAt = parsed.meta.updatedAt || meta.updatedAt;
      meta.name = parsed.meta.name || meta.name;
      const elMap = elements.get(id)!;
      for (const e of parsed.elements || []) {
        if (e?.id) elMap.set(e.id, e);
      }
      const fileMap = files.get(id)!;
      for (const f2 of parsed.files || []) {
        if (f2?.id) fileMap.set(f2.id, f2);
      }
      const snapMap = snapshots.get(id)!;
      for (const s of parsed.snapshots || []) {
        if (s?.name) snapMap.set(s.name, s);
      }
      loaded++;
    } catch (err) {
      logger.error(`Failed to load room from ${fullPath}:`, err);
    }
  }
  logger.info(`Loaded ${loaded} room(s) from ${DATA_DIR}`);
}

export function getDataDir(): string {
  return DATA_DIR;
}
