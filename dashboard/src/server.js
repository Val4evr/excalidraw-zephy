import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT || '5000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const CANVAS_URL = (process.env.CANVAS_URL || 'http://canvas:3000').replace(/\/$/, '');
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const MCP_INSTALL_TEMPLATE = process.env.MCP_INSTALL_TEMPLATE
  || 'claude mcp add excalidraw -s user --env ROOM_ID={{ROOM_ID}} --env EXPRESS_SERVER_URL=http://zephy:3000 -- npx -y --package=github:Val4evr/excalidraw-zephy excalidraw-mcp';

if (!ADMIN_API_KEY) {
  console.error('ADMIN_API_KEY env var is required');
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/api/config', (_req, res) => {
  res.json({
    publicBaseUrl: PUBLIC_BASE_URL,
    mcpInstallTemplate: MCP_INSTALL_TEMPLATE,
  });
});

async function callCanvas(req, res, method, urlPath, body) {
  const url = `${CANVAS_URL}${urlPath}`;
  try {
    const init = {
      method,
      headers: {
        'X-Admin-Key': ADMIN_API_KEY,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const r = await fetch(url, init);
    const text = await r.text();
    res.status(r.status);
    res.set('Content-Type', r.headers.get('content-type') || 'application/json');
    res.send(text);
  } catch (err) {
    console.error(`Canvas proxy error (${method} ${urlPath}):`, err);
    res.status(502).json({ success: false, error: 'Canvas server unreachable' });
  }
}

app.get('/api/rooms', (req, res) => callCanvas(req, res, 'GET', '/api/admin/rooms'));
app.post('/api/rooms', (req, res) => callCanvas(req, res, 'POST', '/api/admin/rooms', req.body));
app.patch('/api/rooms/:id', (req, res) => callCanvas(req, res, 'PATCH', `/api/admin/rooms/${encodeURIComponent(req.params.id)}`, req.body));
app.delete('/api/rooms/:id', (req, res) => callCanvas(req, res, 'DELETE', `/api/admin/rooms/${encodeURIComponent(req.params.id)}`));

app.use(express.static(path.join(__dirname, '../public'), { index: 'index.html' }));

app.get('/health', (_req, res) => res.json({ status: 'healthy' }));

app.listen(PORT, HOST, () => {
  console.log(`Dashboard listening on http://${HOST}:${PORT}`);
  console.log(`Canvas backend: ${CANVAS_URL}`);
});
