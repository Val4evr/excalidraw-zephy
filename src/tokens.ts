// Bearer-token store for the public /mcp endpoint.
//
// Tokens are high-entropy (256-bit) random strings prefixed with `excmcp_`.
// We persist only the SHA-256 of each token so the file on disk is useless
// to anyone who reads it; the plaintext is shown to the operator exactly
// once on creation. There is no recovery path — to rotate, revoke + reissue.
//
// Persistence model mirrors rooms: a single JSON file written atomically
// via tmp + rename. There are typically a handful of tokens per
// installation, so we keep them in memory and rewrite the whole file on
// any change. No debouncing is needed because writes are rare.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import logger from './utils/logger.js';

export interface TokenRecord {
  id: string;            // short public id, used for revocation
  label: string;         // human-readable name (e.g. "claude.ai — Alice")
  hash: string;          // sha256 hex of the plaintext bearer token
  createdAt: string;     // ISO 8601
  lastUsedAt: string | null;
}

const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
const TOKENS_FILE = path.join(DATA_DIR, 'tokens.json');
const TOKEN_PREFIX = 'excmcp_';
const TOKEN_BYTES = 32;          // 256 bits of entropy
const TOKEN_ID_BYTES = 6;        // 8-char base64url id

const tokens = new Map<string, TokenRecord>();
const tokensByHash = new Map<string, TokenRecord>();

function ensureDataDir(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function hashToken(plaintext: string): string {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}

function newId(): string {
  return crypto.randomBytes(TOKEN_ID_BYTES).toString('base64url');
}

function newPlaintextToken(): string {
  return TOKEN_PREFIX + crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

export function loadTokens(): void {
  tokens.clear();
  tokensByHash.clear();
  if (!fs.existsSync(TOKENS_FILE)) return;
  try {
    const raw = fs.readFileSync(TOKENS_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as { tokens?: TokenRecord[] };
    for (const t of parsed.tokens || []) {
      tokens.set(t.id, t);
      tokensByHash.set(t.hash, t);
    }
    logger.info(`Loaded ${tokens.size} bearer tokens from ${TOKENS_FILE}`);
  } catch (err) {
    logger.error(`Failed to load tokens from ${TOKENS_FILE}:`, err);
  }
}

function persist(): void {
  ensureDataDir();
  const tmp = `${TOKENS_FILE}.tmp.${process.pid}`;
  const data = JSON.stringify({ tokens: Array.from(tokens.values()) }, null, 2);
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, TOKENS_FILE);
  // Lock down even if the umask was lax; the file holds password-equivalent material.
  try { fs.chmodSync(TOKENS_FILE, 0o600); } catch { /* best effort */ }
}

export function listTokens(): Array<Omit<TokenRecord, 'hash'>> {
  return Array.from(tokens.values())
    .map(({ hash: _hash, ...rest }) => rest)
    .sort((a, b) => a.createdAt < b.createdAt ? 1 : -1);
}

export interface CreatedToken {
  record: Omit<TokenRecord, 'hash'>;
  plaintext: string;            // shown to operator ONCE
}

export function createToken(label: string): CreatedToken {
  const trimmed = label.trim();
  if (!trimmed) throw new Error('label is required');
  if (trimmed.length > 80) throw new Error('label is too long (max 80 chars)');
  const plaintext = newPlaintextToken();
  const hash = hashToken(plaintext);
  const record: TokenRecord = {
    id: newId(),
    label: trimmed,
    hash,
    createdAt: new Date().toISOString(),
    lastUsedAt: null
  };
  tokens.set(record.id, record);
  tokensByHash.set(hash, record);
  persist();
  const { hash: _hash, ...publicRecord } = record;
  return { record: publicRecord, plaintext };
}

export function revokeToken(id: string): boolean {
  const record = tokens.get(id);
  if (!record) return false;
  tokens.delete(id);
  tokensByHash.delete(record.hash);
  persist();
  return true;
}

// Constant-time-ish lookup. We hash the candidate (variable-cost) and then
// look up by hash (single Map.get). Hash inputs are bounded length so timing
// leakage is minimal; an attacker would need ~2^128 hash queries to forge a
// token regardless.
export function validateToken(plaintext: string): TokenRecord | null {
  if (!plaintext || !plaintext.startsWith(TOKEN_PREFIX)) return null;
  const hash = hashToken(plaintext);
  const record = tokensByHash.get(hash);
  if (!record) return null;
  // Touch lastUsedAt asynchronously so the validation path stays fast and
  // we don't write to disk on every MCP request.
  bumpLastUsed(record);
  return record;
}

// Debounce lastUsedAt persistence: update in memory immediately so concurrent
// validations see the freshest value, but only flush to disk every 60s.
let pendingFlush: NodeJS.Timeout | null = null;
let dirtyHasLastUsed = false;
function bumpLastUsed(record: TokenRecord): void {
  record.lastUsedAt = new Date().toISOString();
  dirtyHasLastUsed = true;
  if (pendingFlush) return;
  pendingFlush = setTimeout(() => {
    pendingFlush = null;
    if (!dirtyHasLastUsed) return;
    dirtyHasLastUsed = false;
    try { persist(); } catch (err) { logger.warn('Failed to flush token lastUsedAt:', err); }
  }, 60_000);
  pendingFlush.unref();
}
