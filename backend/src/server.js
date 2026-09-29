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
const db          = require('./services/db');
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

// Railway puts one proxy in front of this app, so every request's
// socket address is that proxy's, and the visitor's real address is in
// X-Forwarded-For. Without this, the rate limiter below saw everyone
// as the same single visitor: every user, tab and tunnel page shared
// one 300-per-minute allowance, so one busy miner page could get
// everyone else's requests refused. It also logged
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR on every startup.
// 1 = trust exactly one hop (Railway's), not arbitrary client headers.
app.set('trust proxy', 1);

app.use(cors({ origin: '*', credentials: true }));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
// Log HTTP requests, but skip the ones that repeat constantly and say
// nothing: agent-list polling from every open tab, health checks, and
// successful tunnel sub-resource fetches (a single miner page is dozens
// of them). Failures are always logged. LOG_VERBOSE=1 logs everything.
// The miner Web UI tunnel carries the user's login token in its URL
// (?token=...), so the request log was recording a working admin token
// in plain text. Mask it before it's written.
const hideToken = u => String(u || '').replace(/([?&]token=)[^&\s]+/gi, '$1[hidden]');
morgan.token('url', req => hideToken(req.originalUrl || req.url));
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
app.use('/api/farms',     require('./routes/farms'));
app.use('/api/logs',      logRoutes);
app.use('/api/sensors',   sensorRoutes);
app.use('/api/scada',     scadaRoutes);
app.use('/api/fleet',     fleetRoutes);
app.use('/api/webui',     require('./routes/webui'));
app.use('/api/market',    require('./routes/market'));
app.use('/api/earnings',  require('./routes/earnings'));
app.use('/api/insights',  require('./routes/insights'));
app.use('/api/team',      require('./routes/team'));
app.use('/api/power',     require('./routes/power'));
app.use('/api/alerts',    require('./routes/alerts'));   // site alarm setting (Settings page)

// Twilio fetches an alert call's spoken message from here when the call
// is answered. No login (Twilio can't send one) — each link carries a
// random id that only exists for 30 minutes. See services/alerts.js.
app.all('/api/alerts/twiml/:id', require('./services/alerts').twimlHandler);

// A reload inside a single-page miner UI (MaraFW) lands here as e.g.
// /configuration — sends the browser back into the right miner's tunnel.
// Only answers browser page loads; API clients and health checks pass
// through untouched. See routes/webui.js.
app.use(require('./routes/webui').reloadFallback);

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

// Starts the site-level offline-count checker (warns admins on Telegram,
// text + a spoken voice note, when a single site has more than 10
// machines offline, excluding disabled ones) — added onto the existing
// alerts.js rather than replacing it, so its per-machine
// checkWorkerThresholds()/raiseAlert() functions are untouched. Does
// nothing if TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID aren't set.
require('./services/alerts').start();

// Reboots machines that are reachable but at 0 hashrate for N minutes —
// OFF until switched on in Settings. See services/autorestart.js.
require('./services/autorestart').start();
require('./services/farms').load().then(r => console.log(`[FARMS] ${Object.keys(r.farms).length} farm(s), ${Object.keys(r.agents).length} agent PC(s) known`)).catch(e => console.error('[FARMS] load failed:', e.message));

// Finds and merges duplicate machine records (same machine recorded twice
// after an IP change) every 10 minutes — the automatic version of the
// "Find & Merge Duplicates" button, with stricter safety rules since no
// person confirms each merge. See services/dedupe.js for the rules.
require('./services/dedupe').start();

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
  // Live sockets from a miner's web UI opened through the tunnel (Braiins
  // OS dashboard data, Goldshell pool test) are relayed to the miner via
  // its farm agent — see services/webuiSockets.js. Not logged here: a page
  // can open and re-open these often.
  if (pathname.startsWith('/api/webui/')) {
    require('./services/webuiSockets').handleUpgrade(request, socket, head)
      .catch(e => { console.error('[WEBUI] live socket error:', e.message); try { socket.destroy(); } catch (x) {} });
    return;
  }
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
  const pcId     = String(req.headers['x-agent-pc-id'] || '').slice(0, 64) || null;   // agents from v1.1.42
  const envFarm  = req.headers['x-farm-id']       || '';   // only when the PC's .env names a farm
  const farmNameHdr = req.headers['x-farm-name']  || '';
  const subnet   = req.headers['x-subnet']        || '';
  const hostname = String(req.headers['x-hostname'] || 'unknown').slice(0, 80);
  const version  = req.headers['x-agent-version'] || '1.0.0';
  const ips      = String(req.headers['x-local-ips'] || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 16);
  const keyOk    = VALID_KEYS.includes(key);

  // An old agent (no PC id) still needs the real key and its .env farm.
  if (!pcId && !keyOk) {
    console.warn(`[AGENT] ✗ Bad key from "${farmNameHdr || envFarm}" — key starts with "${key.slice(0,8)}"`);
    console.warn(`[AGENT]   Railway AGENT_KEYS = "${process.env.AGENT_KEYS ? '(set)' : '(not set)'}"`);
    ws.close(4001, 'Invalid agent key');
    return;
  }

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', err => console.error(`[AGENT][${hostname}]`, err.message));

  // Messages that arrive while the farm is being looked up are held,
  // then handled in order.
  let farmId = null, held = [], isPending = false;
  ws.on('message', async (raw) => {
    if (!farmId && !isPending) { held.push(raw); return; }
    handle(raw);
  });
  async function handle(raw) {
    let msg; try { msg = JSON.parse(raw); } catch (e) { return; }
    if (isPending) {
      // A PC waiting for its farm only gets heartbeat acks, so its
      // watchdog stays calm; everything else it sends is ignored.
      if (msg.type === 'heartbeat' && ws.readyState === 1) { try { ws.send(JSON.stringify({ type: 'heartbeat_ack' })); } catch (e) {} }
      return;
    }
    try { await agentMgr.handleAgentMessage(farmId, msg); }
    catch (e) { console.error(`[AGENT][${farmId}] Message handling error (isolated, other farms unaffected):`, e.message); }
  }

  const farms = require('./services/farms');
  farms.resolveAgent({ pcId, legacyFarmId: envFarm, legacySource: req.headers['x-farm-id-source'] || 'env',
                       legacyName: farmNameHdr, hostname, keyOk, ips, subnets: subnet ? subnet.split(',') : [], version })
  .then(async r => {
    if (ws.readyState !== 1) return;
    if (r.pending) {
      isPending = true; held = [];
      const workers = await db.loadWorkers().catch(() => []);
      const online = new Set(agentMgr.getAgents().map(a => a.farm_id));
      const ok = farms.addPending({ pc_id: pcId, hostname, ips, subnets: subnet ? subnet.split(',') : [], version,
        connected_at: new Date().toISOString(), ws, key_ok: keyOk, suggested_farm_id: farms.suggestFarm(ips, online, workers) });
      if (!ok) { ws.close(4029, 'Too many new agents waiting'); return; }
      console.log(`[AGENT] ⏳ New PC "${hostname}" (${ips.join(', ') || 'no IP'}) is waiting — choose its farm in Remote Access`);
      try { ws.send(JSON.stringify({ type: 'pending', pc_id: pcId, message: 'Waiting for this PC to be given a farm in the app (Remote Access → New agents).' })); } catch (e) {}
      try { require('./websocket').broadcast({ type: 'agent_pending', pc_id: pcId, hostname }); } catch (e) {}
      ws.on('close', () => farms.removePending(pcId, ws));
      return;
    }
    console.log(`[AGENT] ✓ Connected — ${r.farm_name} (${r.farm_id}) from ${hostname}${pcId ? '' : ' [older agent]'}`);
    // Refused as a duplicate: the socket is already closed, and wiring up
    // handlers for it would let a rejected agent keep feeding the fleet.
    const accepted = agentMgr.registerAgent(ws, {
      farm_id: r.farm_id, farm_name: r.farm_name, subnet: subnet || '(auto)', hostname, agent_version: version,
      pc_id: pcId, ips, subnets: farms.subnetsFor(r.farm_id),
    });
    if (accepted === false) return;
    farmId = r.farm_id;
    // Pass the socket itself — unregisterAgent needs to know whether the
    // socket that just closed is still the registered one, or a stale
    // predecessor whose close arrived after the agent already reconnected.
    ws.on('close', () => agentMgr.unregisterAgent(farmId, ws));
    const q = held; held = [];
    for (const raw of q) await handle(raw);
  })
  .catch(e => { console.error('[AGENT] farm lookup failed:', e.message); try { ws.close(1011, 'Server error'); } catch (x) {} });
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
