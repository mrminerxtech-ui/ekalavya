require('dotenv').config();

// ── Global safety net ──────────────────────────────────────────
// All farm agents share this ONE backend process. Without this,
// a single unexpected error while handling one farm's message
// (an unhandled promise rejection, a bad field in one poll result,
// etc.) can crash the entire Node process — disconnecting every
// other farm at the same moment, even though their own agents and
// connections were completely fine. This makes that impossible:
// any otherwise-fatal error is logged and the server keeps running.
process.on('uncaughtException', (err) => {
  console.error('[FATAL-CAUGHT] Uncaught exception (server stays up):', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL-CAUGHT] Unhandled promise rejection (server stays up):', reason);
});

const express     = require('express');
const http        = require('http');
const WebSocket   = require('ws');
const cors        = require('cors');
const helmet      = require('helmet');
const compression = require('compression');
const morgan      = require('morgan');
const rateLimit   = require('express-rate-limit');

const { initWebSocket }   = require('./websocket');
const { startAutoPoller } = require('./services/poller');
const agentMgr            = require('./services/agentManager');

const authRoutes     = require('./routes/auth');
const workerRoutes   = require('./routes/workers');
const scannerRoutes  = require('./routes/scanner');
const networksRoutes = require('./routes/networks');
const pricesRoutes   = require('./routes/prices');
const statsRoutes    = require('./routes/stats');
const actionsRoutes  = require('./routes/actions');
const customerRoutes = require('./routes/customers');
const agentRoutes    = require('./routes/agents');
const logRoutes      = require('./routes/logs');
const sensorRoutes   = require('./routes/sensors');
const scadaRoutes    = require('./routes/scada');
const fleetRoutes    = require('./routes/fleet');

const app    = express();
const server = http.createServer(app);

app.use(cors({ origin: '*', credentials: true }));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
// Log HTTP requests, but skip the ones that repeat constantly and say
// nothing: agent-list polling from every open tab, health checks, and
// successful tunnel sub-resource fetches (a single miner page is dozens
// of them). Failures are always logged. LOG_VERBOSE=1 logs everything.
app.use(morgan('dev', {
  skip: (req, res) => {
    if (process.env.LOG_VERBOSE === '1') return false;
    if (res.statusCode >= 400) return false;          // never hide a failure
    if (req.path === '/health') return true;
    if (req.path === '/api/agents') return true;
    if (req.path.startsWith('/api/webui/')) return true;
    if (req.path === '/api/market/prices' || req.path === '/api/market') return true;
    return false;
  },
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/api/', rateLimit({ windowMs: 60_000, max: 300 }));

app.use('/api/auth',      authRoutes);
app.use('/api/workers',   workerRoutes);
app.use('/api/scanner',   scannerRoutes);
app.use('/api/networks',  networksRoutes);
app.use('/api/prices',    pricesRoutes);
app.use('/api/stats',     statsRoutes);
app.use('/api/actions',   actionsRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/agents',    agentRoutes);
app.use('/api/logs',      logRoutes);
app.use('/api/sensors',   sensorRoutes);
app.use('/api/scada',     scadaRoutes);
app.use('/api/fleet',     fleetRoutes);
app.use('/api/webui',     require('./routes/webui'));
app.use('/api/market',    require('./routes/market'));
app.use('/api/earnings',  require('./routes/earnings'));
app.use('/api/insights',  require('./routes/insights'));
app.use('/api/team',      require('./routes/team'));

// Accrues each customer's mining earnings every 10 minutes from the
// machines that are actually hashing. Runs on a server-side timer,
// never on page view, so totals reflect observed uptime rather than
// who happened to open the portal.
require('./services/earnings').start();

// Snapshots every miner every 10 minutes, so the software can answer
// "when did this break", "what has this machine's uptime been" and
// "which machines are quietly underperforming" — none of which are
// answerable from live readings alone.
require('./services/insights').start();

app.get('/health', (_, res) => res.json({
  status:    'ok',
  app:       'Ekalavya',
  version:   '1.0.0',
  uptime:    Math.round(process.uptime()),
  agents:    agentMgr.getAgents().length,
  timestamp: new Date().toISOString(),
}));

app.get('/', (_, res) => res.json({
  app: 'Ekalavya API', status: 'running'
}));

app.use((err, req, res, _next) => {
  console.error('[ERROR]', err.message);
  res.status(err.status || 500).json({ error: err.message });
});

// ── Two WebSocket servers — one for frontend, one for agents
const wss      = new WebSocket.Server({ noServer: true });
const agentWss = new WebSocket.Server({ noServer: true });

// ── Route upgrade requests by path ────────────────────────
server.on('upgrade', (request, socket, head) => {
  // url.parse() is deprecated (Node logs a DeprecationWarning for it on
  // every upgrade request, which shows up as an error line in the
  // platform logs). The base only exists to satisfy the URL parser —
  // we just want the path.
  const pathname = new URL(request.url, 'http://localhost').pathname;
  console.log(`[WS] Upgrade: ${pathname}`);

  if (pathname === '/ws') {
    wss.handleUpgrade(request, socket, head, ws => {
      wss.emit('connection', ws, request);
    });
  } else if (pathname === '/agent') {
    agentWss.handleUpgrade(request, socket, head, ws => {
      agentWss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// ── Frontend clients ───────────────────────────────────────
wss.on('connection', ws => {
  console.log('[WS] Frontend connected');
  ws.send(JSON.stringify({ type: 'connected', app: 'Ekalavya' }));
  ws.on('close', () => console.log('[WS] Frontend disconnected'));
  ws.on('error', err => console.error('[WS]', err.message));
});

// ── Farm agents ────────────────────────────────────────────
const VALID_KEYS = (process.env.AGENT_KEYS || 'ekalavya123')
  .split(',').map(k => k.trim());

agentWss.on('connection', (ws, req) => {
  const key      = req.headers['x-agent-key']     || '';
  const farmId   = req.headers['x-farm-id']       || 'farm-' + Date.now();
  const farmName = req.headers['x-farm-name']     || farmId;
  const subnet   = req.headers['x-subnet']        || '192.168.1.0/24';
  const hostname = req.headers['x-hostname']      || 'unknown';
  const version  = req.headers['x-agent-version'] || '1.0.0';

  if (!VALID_KEYS.includes(key)) {
    console.warn(`[AGENT] ✗ Bad key from "${farmName}" — key starts with "${key.slice(0,8)}"`);
    console.warn(`[AGENT]   Railway AGENT_KEYS = "${process.env.AGENT_KEYS || '(not set)'}"`);
    console.warn(`[AGENT]   Fix: set AGENT_KEYS in Railway to match agent's AGENT_KEY`);
    ws.close(4001, 'Invalid agent key');
    return;
  }
  console.log(`[AGENT] ✓ Connected — ${farmName} (${farmId})`);

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // Refused as a duplicate: the socket is already closed, and wiring up
  // handlers for it would let a rejected agent keep feeding the fleet.
  const accepted = agentMgr.registerAgent(ws, {
    farm_id: farmId, farm_name: farmName, subnet, hostname, agent_version: version,
  });
  if (accepted === false) return;

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw);
      await agentMgr.handleAgentMessage(farmId, msg);
    } catch (e) {
      // Isolated to this one farm's message — never lets a problem
      // with one agent's data affect any other agent's connection
      console.error(`[AGENT][${farmId}] Message handling error (isolated, other farms unaffected):`, e.message);
    }
  });
  // Pass the socket itself — unregisterAgent needs to know whether the
  // socket that just closed is still the registered one, or a stale
  // predecessor whose close arrived after the agent already reconnected.
  ws.on('close', () => agentMgr.unregisterAgent(farmId, ws));
  ws.on('error', err => console.error(`[AGENT][${farmId}]`, err.message));
});

// ── Server-side keepalive: ping every 8s, drop anyone that misses
// FOUR consecutive pongs (32s total) — same overall tolerance window
// as before, but far more frequent traffic in between. If Railway's
// own network layer (separate from our app) enforces a shorter idle-
// connection timeout than we expect, this keeps the connection
// active often enough that it never has a chance to trigger.
setInterval(() => {
  agentWss.clients.forEach(ws => {
    if (ws.missedPongs === undefined) ws.missedPongs = 0;
    if (ws.isAlive === false) {
      ws.missedPongs++;
      if (ws.missedPongs >= 4) {
        console.log('[AGENT] No pong for 4 cycles — terminating dead connection');
        return ws.terminate();
      }
    } else {
      ws.missedPongs = 0;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch(e) {}
  });
}, 8000);

// ── Start ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║        EKALAVYA — Server v1.0.0         ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  HTTP   → http://0.0.0.0:${PORT}            ║`);
  console.log(`║  WS     → ws://0.0.0.0:${PORT}/ws           ║`);
  console.log(`║  Agents → ws://0.0.0.0:${PORT}/agent        ║`);
  console.log('╚══════════════════════════════════════════╝\n');
  initWebSocket(server, wss);
  startAutoPoller();
});

module.exports = { app, server };
