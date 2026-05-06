'use strict';

const POLL_MS = 15000;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  rooms: [],
  config: { publicBaseUrl: '', mcpInstallTemplate: '' },
  pollTimer: null,
  loaded: false,
};

/* ---------- Theme ---------- */
const savedTheme = localStorage.getItem('theme');
if (savedTheme === 'light' || savedTheme === 'dark') {
  document.documentElement.dataset.theme = savedTheme;
}
$('#theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('theme', next);
});

/* ---------- Toast ---------- */
let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => { el.hidden = true; }, 250);
  }, 1600);
}

/* ---------- API ---------- */
async function api(method, url, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const r = await fetch(url, init);
  let data = null;
  try { data = await r.json(); } catch {}
  if (!r.ok) {
    const msg = (data && data.error) ? data.error : `${r.status} ${r.statusText}`;
    throw new Error(msg);
  }
  return data;
}

async function fetchConfig() {
  try {
    const data = await api('GET', '/api/config');
    state.config = data;
  } catch {
    // non-fatal
  }
}

async function fetchRooms({ silent = false } = {}) {
  if (!silent) showLoading(!state.loaded);
  try {
    const data = await api('GET', '/api/rooms');
    state.rooms = (data.rooms || []).slice().sort((a, b) =>
      (b.updatedAt || '').localeCompare(a.updatedAt || '')
    );
    state.loaded = true;
    hideBanner();
    render();
  } catch (err) {
    showBanner(err.message || 'Cannot reach canvas server.');
  } finally {
    showLoading(false);
  }
}

/* ---------- Rendering ---------- */
function relativeTime(iso) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  const s = Math.round(diff / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function shareUrlFor(room) {
  if (room.shareUrl && /^https?:/.test(room.shareUrl)) return room.shareUrl;
  if (state.config.publicBaseUrl) return `${state.config.publicBaseUrl}/r/${room.id}`;
  return `${window.location.origin.replace(/:5000$/, ':3000')}/r/${room.id}`;
}

function mcpCommandFor(room) {
  const tpl = state.config.mcpInstallTemplate || '';
  return tpl.replace(/{{ROOM_ID}}/g, room.id);
}

function render() {
  const rowsEl = $('#rows');
  const empty = $('#empty');
  const tpl = $('#row-tpl');

  rowsEl.innerHTML = '';
  if (state.rooms.length === 0 && state.loaded) {
    empty.hidden = false;
  } else {
    empty.hidden = true;
  }

  for (const room of state.rooms) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = room.id;
    $('.name', node).textContent = room.name || '(untitled)';
    $('.col-id', node).textContent = room.id;
    $('.col-id', node).title = room.id;
    $('.col-num', node).textContent = (room.elementCount ?? 0).toLocaleString();
    $('.col-time', node).textContent = relativeTime(room.updatedAt);
    $('.col-time', node).title = new Date(room.updatedAt || 0).toLocaleString();
    $('.open', node).href = shareUrlFor(room);
    rowsEl.appendChild(node);
  }

  $('#meta-public').textContent = state.config.publicBaseUrl || '(local-only)';
  $('#meta-count').textContent = state.rooms.length.toString();
}

function showLoading(visible) {
  $('#loading').hidden = !visible;
}

function showBanner(message) {
  $('#banner-text').textContent = message;
  $('#banner').hidden = false;
}
function hideBanner() {
  $('#banner').hidden = true;
}

/* ---------- Row interactions ---------- */
const rowsEl = $('#rows');
rowsEl.addEventListener('click', (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  const id = row.dataset.id;
  const room = state.rooms.find(r => r.id === id);
  if (!room) return;

  if (e.target.closest('.copy-link')) {
    copy(shareUrlFor(room), 'Share link copied');
  } else if (e.target.closest('.copy-mcp')) {
    openMcpModal(room);
  } else if (e.target.closest('.delete')) {
    openDeleteModal(room);
  }
});

rowsEl.addEventListener('dblclick', (e) => {
  const nameEl = e.target.closest('.name');
  if (nameEl) startInlineEdit(nameEl.closest('.row'));
});
rowsEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('.name')) {
    startInlineEdit(e.target.closest('.row'));
  }
});

function startInlineEdit(rowEl) {
  const id = rowEl.dataset.id;
  const room = state.rooms.find(r => r.id === id);
  const nameEl = $('.name', rowEl);
  const input = $('.name-edit', rowEl);
  input.value = room.name;
  nameEl.hidden = true;
  input.hidden = false;
  input.focus();
  input.select();
  const cleanup = () => {
    input.hidden = true;
    nameEl.hidden = false;
  };
  const submit = async () => {
    const next = input.value.trim();
    cleanup();
    if (!next || next === room.name) return;
    try {
      await api('PATCH', `/api/rooms/${encodeURIComponent(id)}`, { name: next });
      toast('Renamed');
      fetchRooms({ silent: true });
    } catch (err) {
      toast(`Rename failed: ${err.message}`);
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    else if (e.key === 'Escape') { e.preventDefault(); cleanup(); }
  }, { once: true });
  input.addEventListener('blur', submit, { once: true });
}

async function copy(text, msg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(msg || 'Copied');
  } catch {
    // Fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast(msg || 'Copied'); }
    catch { toast('Copy blocked'); }
    finally { document.body.removeChild(ta); }
  }
}

/* ---------- New board modal ---------- */
const newModal = $('#new-modal');
const newForm = $('#new-form');
const newName = $('#new-name');

function openNewModal() {
  newName.value = '';
  newModal.showModal();
  setTimeout(() => newName.focus(), 50);
}

newForm.addEventListener('submit', async (e) => {
  if (e.submitter && e.submitter.value === 'cancel') return;
  e.preventDefault();
  const name = newName.value.trim();
  if (!name) return;
  $('#new-submit').disabled = true;
  try {
    const data = await api('POST', '/api/rooms', { name });
    newModal.close();
    toast('Board created');
    state.rooms = [data.room, ...state.rooms];
    render();
    fetchRooms({ silent: true });
  } catch (err) {
    toast(`Create failed: ${err.message}`);
  } finally {
    $('#new-submit').disabled = false;
  }
});

$('#new-room').addEventListener('click', openNewModal);
document.addEventListener('click', (e) => {
  if (e.target.matches('[data-action="new-room"]')) openNewModal();
});

/* ---------- Delete modal ---------- */
const delModal = $('#del-modal');
const delForm = $('#del-form');
let pendingDelete = null;

function openDeleteModal(room) {
  pendingDelete = room;
  $('#del-name').textContent = room.name || '(untitled)';
  delModal.showModal();
}
delForm.addEventListener('submit', async (e) => {
  if (e.submitter && e.submitter.value !== 'confirm') {
    pendingDelete = null;
    return;
  }
  e.preventDefault();
  if (!pendingDelete) return;
  const id = pendingDelete.id;
  pendingDelete = null;
  try {
    await api('DELETE', `/api/rooms/${encodeURIComponent(id)}`);
    delModal.close();
    toast('Deleted');
    state.rooms = state.rooms.filter(r => r.id !== id);
    render();
  } catch (err) {
    toast(`Delete failed: ${err.message}`);
  }
});

/* ---------- MCP install modal ---------- */
const mcpModal = $('#mcp-modal');
let pendingMcp = null;
function openMcpModal(room) {
  pendingMcp = room;
  $('#mcp-name').textContent = room.name || room.id;
  $('#mcp-cmd').textContent = mcpCommandFor(room);
  mcpModal.showModal();
}
mcpModal.querySelector('form').addEventListener('submit', (e) => {
  if (e.submitter && e.submitter.value === 'copy' && pendingMcp) {
    e.preventDefault();
    copy(mcpCommandFor(pendingMcp), 'Install command copied');
    mcpModal.close();
  }
});

/* ---------- Banner ---------- */
$('#banner-retry').addEventListener('click', () => fetchRooms());

/* ---------- Polling ---------- */
function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(() => {
    if (!document.hidden) fetchRooms({ silent: true });
  }, POLL_MS);
}
function stopPolling() {
  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) fetchRooms({ silent: true });
});

/* ---------- Keyboard shortcuts ---------- */
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea')) return;
  if ((e.key === 'n' || e.key === 'N') && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    openNewModal();
  }
});

/* ---------- Boot ---------- */
(async () => {
  await fetchConfig();
  await fetchRooms();
  startPolling();
})();
