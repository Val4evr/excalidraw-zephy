// Public /mcp endpoint — speaks the MCP Streamable HTTP transport.
//
// This is what Claude.ai's "Add custom connector" dialog talks to. Each
// connector session gets:
//   • A bearer token, validated against the token store on every request
//     (unless MCP_REQUIRE_AUTH=false, in which case the endpoint is open
//     and security collapses to "knowing a room id is the secret" — same
//     model as /r/<id> share links). Default: auth required.
//   • Its own MCP Server instance (built via buildMcpServer() so handlers
//     match the stdio shim exactly).
//   • Its own session-state object held in mcpSessionStorage AsyncLocalStorage,
//     keyed by the MCP-Session-Id header so concurrent friends do not see
//     each other's currentRoom.
//
// We deliberately keep this small: one Express router with three handlers
// (POST/GET/DELETE) and a session map. The MCP SDK's transport object owns
// the actual JSON-RPC framing and SSE plumbing.

import type { Express, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { buildMcpServer, mcpSessionStorage } from './index.js';
import logger from './utils/logger.js';

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  state: { currentRoom: unknown };
  tokenLabel: string;
}

type ValidateTokenFn = (plaintext: string) => { id: string; label: string } | null;

function readBearer(req: Request): string | null {
  const auth = req.header('Authorization');
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m && m[1] ? m[1].trim() : null;
}

export function mountMcpEndpoint(app: Express, validateToken: ValidateTokenFn): void {
  const sessions = new Map<string, SessionEntry>();
  // Auth is required by default. Setting MCP_REQUIRE_AUTH=false drops the
  // bearer check so claude.ai's connector dialog (which only does OAuth, no
  // raw bearer field) can attach. Trades per-connector revocation/auditing
  // for compatibility — only safe if room ids are kept unguessable and the
  // operator trusts every party they share /r/<id> links with.
  const authRequired = process.env.MCP_REQUIRE_AUTH !== 'false';

  function tokenLabelOf(req: Request): string {
    const r = (req as { tokenRecord?: { label?: string } }).tokenRecord;
    return r?.label ?? (authRequired ? '' : 'anonymous');
  }

  // Auth middleware: every /mcp request must carry a valid bearer token,
  // unless auth has been disabled via MCP_REQUIRE_AUTH=false.
  function authMcp(req: Request, res: Response, next: NextFunction): void {
    if (!authRequired) {
      next();
      return;
    }
    const token = readBearer(req);
    if (!token) {
      res.status(401)
        .set('WWW-Authenticate', 'Bearer realm="excalidraw-mcp"')
        .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Missing Authorization: Bearer <token>' }, id: null });
      return;
    }
    const record = validateToken(token);
    if (!record) {
      res.status(401)
        .set('WWW-Authenticate', 'Bearer realm="excalidraw-mcp", error="invalid_token"')
        .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Invalid or revoked bearer token' }, id: null });
      return;
    }
    (req as any).tokenRecord = record;
    next();
  }

  // POST /mcp — JSON-RPC requests (initialize, tool calls, etc).
  // Initialize requests come without a session id; we mint one and create
  // a fresh Server. Subsequent requests carry the MCP-Session-Id header and
  // are routed to the existing transport.
  app.post('/mcp', authMcp, async (req: Request, res: Response) => {
    const sessionId = req.header('mcp-session-id');
    let entry = sessionId ? sessions.get(sessionId) : undefined;

    if (!entry) {
      // Per the MCP Streamable HTTP spec: "If the server has lost track of the
      // session ID (e.g., due to restart), it MUST return HTTP 404 Not Found."
      // 404 signals the client to drop its cached session id and re-initialize;
      // 400 (which we used to return) made some clients give up entirely.
      if (sessionId) {
        logger.info(`[mcp/http] unknown session ${sessionId} — likely stale across server restart; returning 404 so client re-inits`);
        res.status(404).json({
          jsonrpc: '2.0',
          error: { code: -32001, message: `Session ${sessionId} not found (server may have restarted). Re-initialize to get a fresh session id.` },
          id: null
        });
        return;
      }
      if (!isInitializeRequest(req.body)) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: no valid session id provided and request is not initialize' },
          id: null
        });
        return;
      }

      const sessionState: { currentRoom: unknown } = { currentRoom: null };
      let transport!: StreamableHTTPServerTransport;
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          sessions.set(sid, { transport, state: sessionState, tokenLabel: tokenLabelOf(req) });
          logger.info(`[mcp/http] session ${sid} initialized for token "${tokenLabelOf(req)}"`);
        }
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && sessions.has(sid)) {
          sessions.delete(sid);
          logger.info(`[mcp/http] session ${sid} closed`);
        }
      };

      const server = buildMcpServer();
      await server.connect(transport);

      // Run the request inside this session's storage scope so all tool
      // handlers (which access mcpSessionStorage) see the right currentRoom.
      await mcpSessionStorage.run(sessionState as { currentRoom: any }, () => transport.handleRequest(req, res, req.body));
      return;
    }

    const e = entry;
    await mcpSessionStorage.run(e.state as { currentRoom: any }, () => e.transport.handleRequest(req, res, req.body));
  });

  // GET /mcp — server-sent events for notifications and replays.
  app.get('/mcp', authMcp, async (req: Request, res: Response) => {
    const sessionId = req.header('mcp-session-id');
    if (!sessionId) {
      res.status(400).json({ error: 'mcp-session-id header is required' });
      return;
    }
    const entry = sessions.get(sessionId);
    if (!entry) {
      // 404 with a structured JSON-RPC error so clients re-init cleanly.
      res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: `Session ${sessionId} not found (server may have restarted). Re-initialize to get a fresh session id.` },
        id: null
      });
      return;
    }
    await mcpSessionStorage.run(entry.state as { currentRoom: any }, () => entry.transport.handleRequest(req, res));
  });

  // DELETE /mcp — explicit session termination.
  app.delete('/mcp', authMcp, async (req: Request, res: Response) => {
    const sessionId = req.header('mcp-session-id');
    if (!sessionId) {
      res.status(400).json({ error: 'mcp-session-id header is required' });
      return;
    }
    const entry = sessions.get(sessionId);
    if (!entry) {
      // Idempotent: if the session is already gone, treat the delete as a
      // success — the caller wanted it deleted, and it is.
      res.status(204).send();
      return;
    }
    await mcpSessionStorage.run(entry.state as { currentRoom: any }, () => entry.transport.handleRequest(req, res));
  });

  logger.info(
    authRequired
      ? 'Mounted /mcp (Streamable HTTP) endpoint with bearer-token auth'
      : 'Mounted /mcp (Streamable HTTP) endpoint with auth DISABLED (MCP_REQUIRE_AUTH=false) — security relies on room-id unguessability'
  );
}
