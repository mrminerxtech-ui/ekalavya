require('dotenv').config();
const express     = require('express');
const http        = require('http');
const WebSocket   = require('ws');
const url         = require('url');
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
app.use(morgan('dev'));
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
  const { pathname } = url.parse(request.url);
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

  agentMgr.registerAgent(ws, { farm_id: farmId, farm_name: farmName, subnet, hostname, agent_version: version });

  ws.on('message', raw => {
    try { agentMgr.handleAgentMessage(farmId, JSON.parse(raw)); }
    catch (e) { console.error('[AGENT] Parse error:', e.message); }
  });
  ws.on('close', () => agentMgr.unregisterAgent(farmId));
  ws.on('error', err => console.error(`[AGENT][${farmId}]`, err.message));
});

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
