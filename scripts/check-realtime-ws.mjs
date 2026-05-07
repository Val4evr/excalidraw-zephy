import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import WebSocket from 'ws';

const roomId = 'realtime-test-room';

function onceServerListening(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const freePort = typeof address === 'object' && address ? address.port : port;
      server.close(() => resolve(freePort));
    });
    server.on('error', reject);
  });
}

async function waitForHealth(baseUrl, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw lastError || new Error('health check timed out');
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages = [];
    ws.on('message', raw => {
      messages.push(JSON.parse(raw.toString()));
    });
    ws.once('open', () => resolve({ ws, messages }));
    ws.once('error', reject);
  });
}

async function waitForMessage(messages, predicate, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = messages.find(predicate);
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function assertNoMessage(messages, predicate, label, timeoutMs = 300) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (messages.some(predicate)) {
      throw new Error(`Unexpected message: ${label}`);
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

function countMessages(messages, predicate) {
  return messages.filter(predicate).length;
}

const port = await onceServerListening();
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zephy-realtime-'));
await fs.writeFile(path.join(dataDir, `${roomId}.json`), JSON.stringify({
  meta: {
    id: roomId,
    name: 'Realtime test room',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  elements: [],
  files: [],
  snapshots: [],
}));

const child = spawn(process.execPath, ['dist/server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    DATA_DIR: dataDir,
    PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    LOG_FILE_PATH: path.join(dataDir, 'server.log'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const stderr = [];
child.stderr.on('data', chunk => stderr.push(chunk.toString()));

try {
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl);

  const clientA = await connect(`ws://127.0.0.1:${port}/ws/r/${roomId}`);
  const clientB = await connect(`ws://127.0.0.1:${port}/ws/r/${roomId}`);

  await waitForMessage(clientA.messages, message => message.type === 'initial_elements', 'client A initial scene');
  await waitForMessage(clientB.messages, message => message.type === 'initial_elements', 'client B initial scene');

  clientA.ws.send(JSON.stringify({
    type: 'client_join',
    clientId: 'client-a',
    username: 'A',
    color: { background: '#e3fafc', stroke: '#0b7285' },
  }));
  clientB.ws.send(JSON.stringify({
    type: 'client_join',
    clientId: 'client-b',
    username: 'B',
    color: { background: '#fff3bf', stroke: '#e67700' },
  }));

  clientA.ws.send(JSON.stringify({
    type: 'pointer_update',
    clientId: 'client-a',
    pointer: { x: 42, y: 64, tool: 'pointer' },
    button: 'down',
    selectedElementIds: { element_1: true },
  }));

  const pointer = await waitForMessage(
    clientB.messages,
    message => message.type === 'pointer_update' && message.clientId === 'client-a',
    'pointer relay'
  );
  if (pointer.pointer?.x !== 42 || pointer.pointer?.y !== 64 || pointer.button !== 'down') {
    throw new Error(`Pointer relay payload was malformed: ${JSON.stringify(pointer)}`);
  }
  await assertNoMessage(
    clientA.messages,
    message => message.type === 'pointer_update' && message.clientId === 'client-a',
    'pointer echo to origin'
  );

  const element = {
    id: 'element_1',
    type: 'rectangle',
    x: 10,
    y: 20,
    width: 100,
    height: 80,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: { type: 3 },
    seed: 123,
    version: 1,
    versionNonce: 456,
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
    index: 'a0',
  };

  const syncResponse = await fetch(`${baseUrl}/api/r/${roomId}/elements/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: 'client-a',
      elements: [element],
      timestamp: new Date().toISOString(),
    }),
  });
  if (!syncResponse.ok) {
    throw new Error(`sync failed: ${syncResponse.status} ${await syncResponse.text()}`);
  }

  const synced = await waitForMessage(
    clientB.messages,
    message => message.type === 'elements_synced' && message.clientId === 'client-a',
    'scene sync relay'
  );
  if (synced.elements?.[0]?.id !== 'element_1' || synced.elements?.[0]?.x !== 10) {
    throw new Error(`Scene sync payload was malformed: ${JSON.stringify(synced)}`);
  }
  await assertNoMessage(
    clientA.messages,
    message => message.type === 'elements_synced' && message.clientId === 'client-a',
    'scene sync echo to origin'
  );

  const patchedElement = {
    ...element,
    x: 40,
    y: 60,
    version: 2,
    versionNonce: 789,
    updated: Date.now(),
  };
  const patchResponse = await fetch(`${baseUrl}/api/r/${roomId}/elements/patch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: 'client-a',
      elements: [patchedElement],
      deletedElementIds: [],
      timestamp: new Date().toISOString(),
    }),
  });
  if (!patchResponse.ok) {
    throw new Error(`patch failed: ${patchResponse.status} ${await patchResponse.text()}`);
  }

  const patched = await waitForMessage(
    clientB.messages,
    message => message.type === 'elements_patched' && message.clientId === 'client-a',
    'delta patch relay'
  );
  if (patched.elements?.[0]?.id !== 'element_1' || patched.elements?.[0]?.x !== 40) {
    throw new Error(`Delta patch payload was malformed: ${JSON.stringify(patched)}`);
  }
  await assertNoMessage(
    clientA.messages,
    message => message.type === 'elements_patched' && message.clientId === 'client-a',
    'delta patch echo to origin'
  );

  const stalePatchResponse = await fetch(`${baseUrl}/api/r/${roomId}/elements/patch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: 'stale-client',
      traceId: 'test-stale-patch',
      elements: [{ ...element, x: 5, y: 5, version: 1, updated: element.updated - 1000 }],
      deletedElementIds: [],
      timestamp: new Date().toISOString(),
    }),
  });
  if (!stalePatchResponse.ok) {
    throw new Error(`stale patch failed unexpectedly: ${stalePatchResponse.status} ${await stalePatchResponse.text()}`);
  }
  const stalePatch = await stalePatchResponse.json();
  if (stalePatch.staleCount !== 1 || stalePatch.count !== 0) {
    throw new Error(`Stale patch was not rejected: ${JSON.stringify(stalePatch)}`);
  }
  const afterStalePatchResponse = await fetch(`${baseUrl}/api/r/${roomId}/elements/element_1`);
  const afterStalePatch = await afterStalePatchResponse.json();
  if (afterStalePatch.element?.x !== 40 || afterStalePatch.element?.version !== 2) {
    throw new Error(`Stale patch overwrote current element: ${JSON.stringify(afterStalePatch)}`);
  }

  const deletePatchResponse = await fetch(`${baseUrl}/api/r/${roomId}/elements/patch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: 'client-a',
      traceId: 'test-delete-patch',
      elements: [],
      deletedElementIds: ['element_1'],
      timestamp: new Date().toISOString(),
    }),
  });
  if (!deletePatchResponse.ok) {
    throw new Error(`delete patch failed: ${deletePatchResponse.status} ${await deletePatchResponse.text()}`);
  }

  const staleResurrectionResponse = await fetch(`${baseUrl}/api/r/${roomId}/elements/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: 'stale-client',
      traceId: 'test-stale-resurrection',
      replace: false,
      elements: [{ ...patchedElement, x: 40, y: 60 }],
      timestamp: new Date().toISOString(),
    }),
  });
  if (!staleResurrectionResponse.ok) {
    throw new Error(`stale resurrection sync failed unexpectedly: ${staleResurrectionResponse.status} ${await staleResurrectionResponse.text()}`);
  }
  const staleResurrection = await staleResurrectionResponse.json();
  if (staleResurrection.tombstoneRejectedCount !== 1 || staleResurrection.count !== 0) {
    throw new Error(`Deleted element resurrection was not rejected: ${JSON.stringify(staleResurrection)}`);
  }
  const afterDeleteResponse = await fetch(`${baseUrl}/api/r/${roomId}/elements/element_1`);
  if (afterDeleteResponse.status !== 404) {
    throw new Error(`Deleted element was resurrected; GET returned ${afterDeleteResponse.status} ${await afterDeleteResponse.text()}`);
  }

  const mcpTransport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/index.js'],
    cwd: process.cwd(),
    env: {
      ...process.env,
      ROOM_ID: roomId,
      EXPRESS_SERVER_URL: baseUrl,
      ENABLE_CANVAS_SYNC: 'true',
      MCP_AGENT_CURSOR: 'true',
      MCP_AGENT_NAME: 'Test MCP Agent',
      MCP_AGENT_COLOR: '#6741d9',
      LOG_FILE_PATH: path.join(dataDir, 'mcp-agent.log'),
    },
    stderr: 'pipe',
  });
  const mcpClient = new Client({ name: 'realtime-test-client', version: '1.0.0' });
  await mcpClient.connect(mcpTransport);

  await mcpClient.callTool({
    name: 'create_element',
    arguments: {
      id: 'mcp_agent_cursor_element',
      type: 'rectangle',
      x: 250,
      y: 260,
      width: 80,
      height: 40,
    },
  });

  const agentPointer = await waitForMessage(
    clientB.messages,
    message => message.type === 'pointer_update' &&
      typeof message.clientId === 'string' &&
      message.clientId.startsWith('mcp-agent-') &&
      message.username === 'Test MCP Agent · create_element',
    'MCP agent cursor activity'
  );
  if (
    Math.round(agentPointer.pointer?.x) !== 290 ||
    Math.round(agentPointer.pointer?.y) !== 280 ||
    agentPointer.button !== 'down' ||
    agentPointer.selectedElementIds?.mcp_agent_cursor_element !== true ||
    agentPointer.color?.stroke !== '#6741d9'
  ) {
    throw new Error(`MCP agent cursor payload was malformed: ${JSON.stringify(agentPointer)}`);
  }

  const agentIdle = await waitForMessage(
    clientB.messages,
    message => message.type === 'pointer_update' &&
      message.clientId === agentPointer.clientId &&
      message.username === 'Test MCP Agent' &&
      message.button === 'up',
    'MCP agent cursor idle update'
  );
  if (agentIdle.pointer?.renderCursor !== true) {
    throw new Error(`MCP agent idle payload was malformed: ${JSON.stringify(agentIdle)}`);
  }

  await mcpClient.close();
  const agentDisconnect = await waitForMessage(
    clientB.messages,
    message => message.type === 'client_disconnected' && message.clientId === agentPointer.clientId,
    'MCP agent cursor disconnect'
  );
  if (agentDisconnect.clientId !== agentPointer.clientId) {
    throw new Error(`MCP agent disconnect payload was malformed: ${JSON.stringify(agentDisconnect)}`);
  }

  const disabledPointerCountBefore = countMessages(
    clientB.messages,
    message => message.type === 'pointer_update' && message.username === 'Disabled MCP Agent · create_element'
  );
  const disabledTransport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/index.js'],
    cwd: process.cwd(),
    env: {
      ...process.env,
      ROOM_ID: roomId,
      EXPRESS_SERVER_URL: baseUrl,
      ENABLE_CANVAS_SYNC: 'true',
      MCP_AGENT_CURSOR: 'false',
      MCP_AGENT_NAME: 'Disabled MCP Agent',
      LOG_FILE_PATH: path.join(dataDir, 'mcp-agent-disabled.log'),
    },
    stderr: 'pipe',
  });
  const disabledClient = new Client({ name: 'realtime-test-disabled-client', version: '1.0.0' });
  await disabledClient.connect(disabledTransport);
  await disabledClient.callTool({
    name: 'create_element',
    arguments: {
      id: 'mcp_agent_cursor_disabled_element',
      type: 'rectangle',
      x: 350,
      y: 360,
      width: 80,
      height: 40,
    },
  });
  await assertNoMessage(
    clientB.messages,
    message => message.type === 'pointer_update' &&
      message.username === 'Disabled MCP Agent · create_element' &&
      countMessages(clientB.messages, candidate => (
        candidate.type === 'pointer_update' &&
        candidate.username === 'Disabled MCP Agent · create_element'
      )) > disabledPointerCountBefore,
    'disabled MCP agent cursor activity',
    500
  );
  await disabledClient.close();

  clientA.ws.close(1000, 'test complete');
  const disconnect = await waitForMessage(
    clientB.messages,
    message => message.type === 'client_disconnected' && message.clientId === 'client-a',
    'client disconnect relay'
  );
  if (disconnect.clientId !== 'client-a') {
    throw new Error(`Disconnect payload was malformed: ${JSON.stringify(disconnect)}`);
  }

  clientB.ws.close(1000, 'test complete');
  console.log(`Realtime websocket check passed on port ${port}`);
} finally {
  child.kill('SIGTERM');
  await new Promise(resolve => child.once('exit', resolve));
  await fs.rm(dataDir, { recursive: true, force: true });
  if (child.exitCode && child.exitCode !== 0 && stderr.length) {
    console.error(stderr.join(''));
  }
}
