// ============================================================
// LIVE SOCKETS THROUGH THE WEB UI TUNNEL
// ------------------------------------------------------------
// Some miner dashboards stream their data over a WebSocket instead of
// asking for it request by request — Braiins OS 26.x sends hashrate,
// chip temperatures, fans, hashboards and pools over a GraphQL socket at
// /graphql. The tunnel used to refuse every socket under /api/webui/, so
// those pages logged in, drew their layout, and then spun forever.
//
//   browser ⇄ this server (/api/webui/<farm>/<ip>/<path>, upgrade)
//           ⇄ farm agent (webui_ws_* messages on its own connection)
//           ⇄ miner (ws://<ip>/<path>)
//
// The browser's socket is only accepted once the agent has actually
// reached the miner, so the page sees the miner's own sub-protocol
// (graphql-transport-ws etc.) or a clean failure — never a socket that
// opens and then goes nowhere. Same login rules as the page tunnel:
// a staff token, or a customer who owns that machine.
// ============================================================
const WebSocket = require('ws');
const jwt       = require('jsonwebtoken');
const agentMgr  = require('./agentManager');
const db        = require('./db');

const JWT_SECRET      = process.env.JWT_SECRET || 'dev-secret-change-in-prod';
const COOKIE_NAME     = 'ekl_webui_auth';
const OPEN_TIMEOUT_MS = 10000;
const MAX_PER_FARM    = 30;
const IP_RE           = /^\d{1,3}(?:\.\d{1,3}){3}$/;

// Chooses, for each browser handshake, the sub-protocol the MINER agreed to.
const server = new WebSocket.Server({
  noServer: true,
  perMessageDeflate: false,
  handleProtocols: (_offered, request) => (request && request.__eklProtocol) || false,
});

const tunnels = new Map();   // id -> { farmId, ip, browser, pending:[], state }

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(pair => {
    const i = pair.indexOf('=');
    if (i > -1) { try { out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim()); } catch (e) {} }
  });
  return out;
}
function refuse(socket, code, text) {
  try { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch (e) {}
  try { socket.destroy(); } catch (e) {}
}
// sendToAgent, not getAgent().ws: getAgent() returns a copy without the
// connection, so sending through it failed every time — every live socket
// was refused within milliseconds ("WebSocket connection … failed").
function toAgent(farmId, payload) {
  return agentMgr.sendToAgent(farmId, payload);
}

async function allowed(user, farmId, ip) {
  if (!user) return false;
  if (user.role !== 'customer') return true;
  const has = v => v !== null && v !== undefined && String(v).trim() !== '';
  if (!has(user.id)) return false;
  const all = await db.loadWorkers();
  return all.some(w => w && w.farm_id === farmId && w.ip === ip && has(w.cid) && String(w.cid) === String(user.id));
}

// Called from server.js for every upgrade under /api/webui/.
async function handleUpgrade(request, socket, head) {
  let u;
  try { u = new URL(request.url, 'http://localhost'); } catch (e) { return refuse(socket, 400, 'Bad Request'); }
  const m = u.pathname.match(/^\/api\/webui\/([^/]+)\/([^/]+)(\/.*)?$/);
  if (!m) return refuse(socket, 400, 'Bad Request');
  let farmId; try { farmId = decodeURIComponent(m[1]); } catch (e) { farmId = m[1]; }
  const ip = m[2];
  if (!IP_RE.test(ip)) return refuse(socket, 400, 'Bad Request');

  const cookies = parseCookies(request.headers.cookie);
  const token = u.searchParams.get('token') || cookies[COOKIE_NAME];
  let user = null;
  try { user = token ? jwt.verify(token, JWT_SECRET) : null; } catch (e) { user = null; }
  if (!user) return refuse(socket, 401, 'Unauthorized');
  try { if (!(await allowed(user, farmId, ip))) return refuse(socket, 403, 'Forbidden'); }
  catch (e) { return refuse(socket, 500, 'Internal Server Error'); }

  if (!agentMgr.getAgent(farmId)) return refuse(socket, 502, 'Bad Gateway');
  let open = 0; tunnels.forEach(t => { if (t.farmId === farmId) open++; });
  if (open >= MAX_PER_FARM) return refuse(socket, 503, 'Service Unavailable');

  // Path + query for the miner, without our own bits.
  u.searchParams.delete('token');
  const port = u.searchParams.get('__eklport'); u.searchParams.delete('__eklport');
  const qs = u.searchParams.toString();
  const minerPath = (m[3] || '/') + (qs ? '?' + qs : '');
  const protocols = String(request.headers['sec-websocket-protocol'] || '').split(',').map(s => s.trim()).filter(Boolean);
  const minerCookie = String(request.headers.cookie || '').split(';').map(c => c.trim())
    .filter(c => c && !c.startsWith(COOKIE_NAME + '=')).join('; ');
  const headers = {};
  if (minerCookie) headers.cookie = minerCookie;
  if (request.headers.authorization) headers.authorization = request.headers.authorization;

  const id = 'ws-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const t = { farmId, ip, path: minerPath, browser: null, pending: [], state: 'opening', socket };
  tunnels.set(id, t);
  t.timer = setTimeout(() => {
    if (t.state !== 'opening') return;
    tunnels.delete(id);
    console.warn(`[WEBUI] ✗ live socket ${minerPath} (farm=${farmId} ip=${ip}) — agent did not answer (agent older than v1.1.39?)`);
    toAgent(farmId, { type: 'webui_ws_close', id });
    refuse(socket, 504, 'Gateway Timeout');
  }, OPEN_TIMEOUT_MS);
  socket.on('error', () => {});
  socket.once('close', () => {
    if (t.state === 'opening') { clearTimeout(t.timer); tunnels.delete(id); toAgent(farmId, { type: 'webui_ws_close', id }); }
  });
  t.accept = (protocol) => {
    request.__eklProtocol = protocol || false;
    server.handleUpgrade(request, socket, head, ws => {
      t.browser = ws; t.state = 'open';
      ws.on('message', (data, isBinary) => {
        const binary = typeof data !== 'string' && isBinary !== false;
        toAgent(farmId, { type: 'webui_ws_data', id, binary,
          data: typeof data === 'string' ? data : (binary ? Buffer.from(data).toString('base64') : Buffer.from(data).toString('utf8')) });
      });
      ws.on('close', () => { if (tunnels.delete(id)) toAgent(farmId, { type: 'webui_ws_close', id }); });
      ws.on('error', () => {});
      t.pending.forEach(f => deliver(ws, f)); t.pending = [];
    });
  };

  if (!toAgent(farmId, { type: 'webui_ws_open', id, ip, path: minerPath, protocols, headers, port: port ? Number(port) : undefined })) {
    clearTimeout(t.timer); tunnels.delete(id);
    return refuse(socket, 502, 'Bad Gateway');
  }
}

function deliver(ws, msg) {
  if (ws.readyState !== 1) return;
  try { ws.send(msg.binary ? Buffer.from(msg.data || '', 'base64') : String(msg.data || ''), { binary: !!msg.binary }); } catch (e) {}
}
function safeCloseCode(c) { c = Number(c); return (c === 1000 || (c >= 3000 && c <= 4999)) ? c : 1000; }

// Messages from the agent about a live socket.
function onAgentMessage(farmId, msg) {
  const t = tunnels.get(msg.id);
  if (!t || t.farmId !== farmId) {
    // unknown / already closed — tell the agent to drop its side
    if (msg.type === 'webui_ws_opened' || msg.type === 'webui_ws_data') toAgent(farmId, { type: 'webui_ws_close', id: msg.id });
    return;
  }
  if (msg.type === 'webui_ws_opened') {
    if (t.state !== 'opening') return;
    clearTimeout(t.timer); t.state = 'accepting';
    console.log(`[WEBUI] ✓ live socket ${t.path} open (farm=${farmId} ip=${t.ip}${msg.protocol ? ', ' + msg.protocol : ''})`);
    t.accept(msg.protocol);
  } else if (msg.type === 'webui_ws_error') {
    clearTimeout(t.timer); tunnels.delete(msg.id);
    console.warn(`[WEBUI] ✗ live socket ${t.path} (farm=${farmId} ip=${t.ip}) — ${msg.error || 'miner refused'}`);
    if (t.browser) { try { t.browser.close(1011); } catch (e) {} }
    else refuse(t.socket, 502, 'Bad Gateway');
  } else if (msg.type === 'webui_ws_data') {
    if (t.browser) deliver(t.browser, msg); else t.pending.push(msg);
  } else if (msg.type === 'webui_ws_closed') {
    tunnels.delete(msg.id);
    if (t.browser) { try { t.browser.close(safeCloseCode(msg.code), String(msg.reason || '').slice(0, 120)); } catch (e) {} }
    else { clearTimeout(t.timer); refuse(t.socket, 502, 'Bad Gateway'); }
  }
}

// The farm's agent went away — every socket through it is dead.
function closeFarm(farmId) {
  tunnels.forEach((t, id) => {
    if (t.farmId !== farmId) return;
    tunnels.delete(id); clearTimeout(t.timer);
    if (t.browser) { try { t.browser.close(1011, 'Farm agent disconnected'); } catch (e) {} }
    else refuse(t.socket, 502, 'Bad Gateway');
  });
}

module.exports = { handleUpgrade, onAgentMessage, closeFarm, _tunnels: tunnels };
