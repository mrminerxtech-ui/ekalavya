require('dotenv').config();
const WebSocket = require('ws');
const crypto = require('crypto');
const net       = require('net');
const http      = require('http');
const https     = require('https');
const os        = require('os');
const { execFile } = require('child_process');

// ── Sonoff TH16 — Live LAN Sensors ───────────────────────
const th16 = require('./sonoff-th');

// Parse sensors from env: IP or IP:deviceId:apikey (comma separated)
function parseTHEnv() {
  return (process.env.TH16_SENSORS || '').split(',')
    .map(s => { const [ip,did,key] = s.trim().split(':'); return ip?{ip,deviceId:did||'',apikey:key||'',name:ip}:null; })
    .filter(Boolean);
}

// Resolve MAC addresses from env on startup
async function resolveEnvMACs() {
  const macList = (process.env.TH16_MACS || '').split(',').map(m=>m.trim()).filter(Boolean);
  if (macList.length === 0) return;
  console.log(`[TH16] Resolving ${macList.length} MAC address(es) from env...`);
  const found = await th16.discoverByMAC(macList);
  found.forEach(s => { if(s.ip) console.log(`[TH16] Resolved: ${s.mac} → ${s.ip}`); });
}

// Called on every live reading — push to backend immediately
function onSensorReading(ip, reading) {
  const farmId   = FARM_ID;
  const farmName = process.env.FARM_NAME || FARM_ID;
  console.log(`[TH16] ${ip} → ${reading.temp}°C ${reading.humidity}% (${reading.source||'http'})`);
  // Push via WebSocket to backend
  send({ type: 'sensor_reading', farm_id: farmId, ip, ...reading });
  // Also POST to /api/sensors/push for immediate dashboard update
  postJson(restUrl('/api/sensors/push'), {
    farm_id:   farmId,
    farm_name: farmName,
    ip,
    temp:      reading.temp,
    humidity:  reading.humidity,
    model:     reading.model || null,
    sensors:   th16.getReadings(),
    timestamp: new Date().toISOString(),
  }).catch(() => {});
}

// Start mDNS listener (passive — catches broadcasts instantly)
// Start polling configured sensors
th16.startLivePolling(parseTHEnv(), 30000, onSensorReading);
// Resolve MAC addresses (if configured) after 10 seconds
setTimeout(resolveEnvMACs, 10000);

// ── Lanli RS485 (optional — only if LANLI_RS485_PORT set) ──
const LANLI_ENABLED = !!process.env.LANLI_RS485_PORT;
let   lanli         = null;
if (LANLI_ENABLED) {
  try {
    lanli = require('./lanli-rs485');
    console.log('[LANLI] RS485 module loaded — port:', process.env.LANLI_RS485_PORT);
  } catch(e) {
    console.warn('[LANLI] RS485 module load failed:', e.message);
    console.warn('[LANLI] Run: npm install modbus-serial');
  }
}

// ── HMI Screenshot (optional — only if LANLI_HMI_ENABLED=true) ──
const HMI_ENABLED  = process.env.LANLI_HMI_ENABLED === 'true';
const HMI_INTERVAL = parseInt(process.env.LANLI_HMI_INTERVAL || '10') * 1000;

const SERVER    = process.env.MMX_SERVER   || 'wss://ekalavya-backend-production.up.railway.app/agent';
const AGENT_KEY = process.env.AGENT_KEY    || 'ekalavya123';
const FARM_NAME = process.env.FARM_NAME    || 'My Farm';
const FARM_ID   = process.env.FARM_ID      || 'farm-' + os.hostname().toLowerCase().replace(/[^a-z0-9]/g,'-');
const SUBNET_RAW = process.env.LOCAL_SUBNET || '192.168.1.0/24';
// Support comma-separated subnets: "192.168.70.1-255,192.168.44.1-255"
const SUBNETS   = SUBNET_RAW.split(',').map(function(s){ return s.trim(); }).filter(Boolean);
const SUBNET    = SUBNETS[0];  // first one for display/registration
const POLL_MS   = parseInt(process.env.POLL_MS || '30000');
const CGPORT    = parseInt(process.env.CGMINER_PORT || '4028');

// ── One agent per farm, enforced locally ────────────────────
// Two agents sharing a FARM_ID fight: each registration kicks the other
// off the backend, the kicked one reconnects, and they trade places
// indefinitely. The commonest cause is simply two copies running on the
// same PC — someone starts agent.js by hand while update-check.js is
// already supervising one. A lock file makes that impossible to do by
// accident, and says so clearly rather than failing mysteriously.
const LOCK_STALE_MS = 3 * 60 * 1000; // see touchLock() below
let touchLockInterval = null;
(function claimSingleInstance() {
  const fsLock   = require('fs');
  const pathLock = require('path');
  const lockFile = pathLock.join(__dirname, '.agent.lock');
  try {
    if (fsLock.existsSync(lockFile)) {
      const prev = parseInt(fsLock.readFileSync(lockFile, 'utf8').trim(), 10);
      // How long ago the lock file was last written/touched. A genuinely
      // alive agent updates this every 8s (see touchLockInterval below),
      // so anything much older than that means whatever wrote it is gone
      // — even if process.kill(prev, 0) below still reports "alive",
      // which happens whenever the OS has since reassigned that same PID
      // number to a completely unrelated process. That reassignment is
      // exactly what was hitting this farm's PC: the real fix for "a
      // stale lock left behind by a crashed agent" (changelog, v1.1.26)
      // has to be based on the lock's age, not just on whether some
      // process happens to occupy that PID number today — checking the
      // PID alone was never enough, and kept refusing to start.
      let ageMs = Infinity;
      try { ageMs = Date.now() - fsLock.statSync(lockFile).mtimeMs; } catch(e) {}
      const stale = ageMs > LOCK_STALE_MS;

      if (prev && prev !== process.pid && !stale) {
        let alive = false;
        // Signal 0 checks for the process without touching it.
        try { process.kill(prev, 0); alive = true; } catch(e) { alive = false; }
        if (alive) {
          console.error('');
          console.error('  ════════════════════════════════════════════════════════');
          console.error(`  An agent is ALREADY RUNNING on this PC (process ${prev}).`);
          console.error('');
          console.error('  Two agents with the same FARM_ID knock each other');
          console.error('  offline in a loop, so this one will not start.');
          console.error('');
          console.error('  Close the other agent window first, or just let the');
          console.error('  existing one keep running — it is already connected.');
          console.error('  ════════════════════════════════════════════════════════');
          console.error('');
          process.exit(0);   // 0 = deliberate, so the supervisor doesn't count it as a crash
        }
      } else if (prev && prev !== process.pid && stale) {
        console.log(`[LOCK] Found a stale lock from process ${prev} (last touched ${Math.round(ageMs/1000)}s ago) — reclaiming it.`);
      }
    }
    fsLock.writeFileSync(lockFile, String(process.pid), 'utf8');
    const release = () => { try { fsLock.unlinkSync(lockFile); } catch(e) {} if (touchLockInterval) clearInterval(touchLockInterval); };
    // Keep the lock file's mtime current for as long as this process is
    // actually alive, so a future startup can tell "still running" apart
    // from "crashed a while ago" purely from the file, regardless of PID
    // reuse. Cleared again in release() above.
    touchLockInterval = setInterval(() => {
      try { fsLock.utimesSync(lockFile, new Date(), new Date()); } catch(e) {}
    }, 8000);
    process.on('exit', release);
    process.on('SIGINT',  () => { release(); process.exit(0); });
    process.on('SIGTERM', () => { release(); process.exit(0); });
  } catch(e) {
    // A read-only folder or odd permissions must never stop the agent
    // from doing its job — the backend still catches duplicates.
    console.log('[LOCK] Could not use a lock file (' + e.message + ') — continuing');
  }
})();

let ws = null, reconnectMs = 3000, pollTimer = null;

// ── Independent watchdog — a safety net completely separate from the
// per-connection ping/pong logic below. That mechanism depends on the
// WebSocket library correctly firing a 'close' event when a connection
// dies — which can silently fail to happen at all if the connection is
// cut by an intermediate network layer (a proxy, a load balancer)
// without a clean close signal ever reaching this process. If that
// happens, the agent can be left permanently stuck, believing it's
// still connected, with no 'close' event ever arriving to trigger a
// reconnect — exactly matching a farm going offline for 30+ minutes
// until someone manually restarts it. This watchdog doesn't rely on
// the ws object's own event system at all: it just tracks "was there
// ANY successful activity recently," and if not, forces a full,
// clean process restart — precisely what a manual restart already
// does and already reliably fixes.
// lastServerMsgAt tracks APPLICATION-level replies from the backend
// (heartbeat_ack, welcome, commands) — deliberately NOT protocol-level
// pongs. A pong proves something on the network answered; it does not
// prove our backend still knows this agent exists. Railway's edge sits
// in front of the app and can keep a socket alive and answer pings by
// itself, so an agent could sit "connected" for hours, pongs flowing,
// while the backend behind that edge had no record of it — online in
// this log, offline in the software, until someone restarted it by hand.
// The backend replies heartbeat_ack to every heartbeat ONLY while the
// agent is registered, so a gap in acks is the real signal.
let lastServerMsgAt      = Date.now();
let lastConnectAttemptAt = 0;
let reconnectScheduled   = false;
let wsGeneration         = 0;

// Last-resort watchdog. Restarting the process does NOT fix an
// unreachable backend, so this no longer fires just because the server
// is down — the reconnect loop handles outages on its own, and killing
// the process during one only risks tripping the supervisor's
// crash-loop backoff and leaving the farm dark for several minutes.
// It now fires only for states the reconnect loop cannot get out of.
setInterval(() => {
  const connected = ws && ws.readyState === 1; // 1 = OPEN
  const silentFor = Date.now() - lastServerMsgAt;

  // Wedged: not connected, nothing scheduled to reconnect, and the last
  // attempt is long past — no timer will ever fire, so nothing will
  // recover this without a restart.
  if (!connected && !reconnectScheduled && Date.now() - lastConnectAttemptAt > 60000) {
    console.log('[WATCHDOG] Not connected and no reconnect pending — state is wedged, restarting process');
    process.exit(1); // the supervisor (update-check.js) restarts agent.js fresh
  }

  // Total silence for 5 minutes in any state. Long enough that a normal
  // deploy or a brief outage never triggers it.
  if (silentFor > 5 * 60 * 1000) {
    console.log(`[WATCHDOG] No reply from the server in ${Math.round(silentFor/60000)} min — restarting process as a last resort`);
    process.exit(1);
  }
}, 15000);

// ── HTTP helper ────────────────────────────────────────────
// ── Parse WWW-Authenticate header for Digest auth ──────────
function parseDigestHeader(header) {
  const params = {};
  const regex = /(\w+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = regex.exec(header)) !== null) {
    params[m[1]] = m[2].replace(/^"|"$/g, '');
  }
  return params;
}

// ── Build Digest Authorization header ──────────────────────
// ncOverride matters when a nonce is REUSED across requests (see the
// digest challenge cache used by the Web UI tunnel). A server that
// tracks nonce counts rejects a repeated nc, so each reuse must pass
// the next value in sequence.
function buildDigestAuth(user, pass, method, path, digestParams, ncOverride) {
  const realm  = digestParams.realm || '';
  const nonce  = digestParams.nonce || '';
  const qop    = digestParams.qop || '';
  const opaque = digestParams.opaque;
  const nc     = ncOverride || '00000001';
  const cnonce = crypto.randomBytes(8).toString('hex');

  const ha1 = crypto.createHash('md5').update(user + ':' + realm + ':' + pass).digest('hex');
  const ha2 = crypto.createHash('md5').update(method + ':' + path).digest('hex');

  let response;
  if (qop) {
    response = crypto.createHash('md5').update(ha1 + ':' + nonce + ':' + nc + ':' + cnonce + ':' + qop + ':' + ha2).digest('hex');
  } else {
    response = crypto.createHash('md5').update(ha1 + ':' + nonce + ':' + ha2).digest('hex');
  }

  let header = 'Digest username="' + user + '", realm="' + realm + '", nonce="' + nonce + '", uri="' + path + '", response="' + response + '"';
  if (qop) header += ', qop=' + qop + ', nc=' + nc + ', cnonce="' + cnonce + '"';
  if (opaque) header += ', opaque="' + opaque + '"';
  return header;
}

// ── HTTP GET with auto Basic → Digest fallback ─────────────
function httpGet(ip, path, auth, debug) {
  const [user, pass] = (auth || '').split(':');
  return new Promise(resolve => {
    function attempt(authHeader, isRetry) {
      const headers = authHeader ? { 'Authorization': authHeader } : {};
      const req = http.request({ hostname: ip, port: 80, path, method: 'GET', headers, timeout: 4000 }, res => {
        // 401 on first try — check if server wants Digest auth
        if (res.statusCode === 401 && !isRetry && res.headers['www-authenticate']) {
          const wa = res.headers['www-authenticate'];
          if (debug) console.log('[HTTP] ' + ip + path + ' → 401, retrying with Digest (' + wa.split(' ')[0] + ')');
          res.resume(); // drain response
          if (wa.toLowerCase().startsWith('digest') && user && pass) {
            const params = parseDigestHeader(wa);
            const digestHeader = buildDigestAuth(user, pass, 'GET', path, params);
            attempt(digestHeader, true);
          } else {
            resolve(null);
          }
          return;
        }
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          if (debug) console.log('[HTTP] ' + ip + path + ' → status ' + res.statusCode + ' | body: ' + d.slice(0,200));
          // The status code was previously ignored entirely, so a 404
          // or 401 page came back as a perfectly truthy string. Callers
          // that try several endpoints in turn ("if (result) return
          // result") then stopped at the FIRST one and handed back the
          // miner's error page as though it were the data — which is
          // why downloading an Antminer log produced an error page
          // instead of a log, and never fell through to the endpoints
          // that would have worked.
          if (res.statusCode < 200 || res.statusCode >= 300) {
            if (debug) console.log('[HTTP] ' + ip + path + ' → treating HTTP ' + res.statusCode + ' as no data');
            return resolve(null);
          }
          try { resolve(JSON.parse(d)); } catch(e) { resolve(d || null); }
        });
      });
      req.on('error',   e => { if (debug) console.log('[HTTP] ' + ip + path + ' → ERROR: ' + e.message); resolve(null); });
      req.on('timeout', () => { if (debug) console.log('[HTTP] ' + ip + path + ' → TIMEOUT'); req.destroy(); resolve(null); });
      req.end();
    }
    const basicAuth = auth ? 'Basic ' + Buffer.from(auth).toString('base64') : null;
    attempt(basicAuth, false);
  });
}

// ── HTTP POST with Digest-auth fallback — used for miner control
// actions (set_miner_conf.cgi, reboot.cgi, etc). Mirrors httpGet's
// auto Basic→Digest retry, since these same miners require it. ──────
// Resolves with { status, body } — status:0 means the connection
// itself failed (never reached the miner). Any other status is
// whatever the miner's web server actually returned, so callers can
// tell "200 OK" apart from "404 no such endpoint" or "500 error" —
// this used to just resolve the body either way, which made it
// impossible to tell a genuine success from a silent failure.
//
// Some miner CGI scripts (simple trigger-actions like reboot.cgi)
// only accept GET, not POST, and reply "405 Method Not Allowed" if
// sent the wrong way. Rather than needing to know this in advance
// for every firmware, we just retry automatically as GET whenever
// that specific rejection happens.
function httpPost(ip, port, path, body, timeout, auth) {
  auth = auth || 'root:root';
  const [user, pass] = auth.split(':');
  return new Promise(resolve => {
    function attempt(authHeader, isRetry, httpMethod) {
      const method = httpMethod || 'POST';
      const headers = {};
      if (method === 'POST') {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(body || '');
      }
      if (authHeader) headers['Authorization'] = authHeader;
      const req = http.request({ hostname: ip, port: port || 80, path, method, headers, timeout: timeout || 5000 }, res => {
        if (res.statusCode === 401 && !isRetry && res.headers['www-authenticate']) {
          const wa = res.headers['www-authenticate'];
          res.resume();
          if (wa.toLowerCase().startsWith('digest') && user && pass) {
            const params = parseDigestHeader(wa);
            const digestHeader = buildDigestAuth(user, pass, method, path, params);
            attempt(digestHeader, true, method);
          } else {
            resolve({ status: 401, body: null });
          }
          return;
        }
        if (res.statusCode === 405 && method === 'POST') {
          // This script doesn't accept POST — try again as a plain GET
          res.resume();
          attempt(authHeader, isRetry, 'GET');
          return;
        }
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(d); } catch(e) { parsed = d || null; }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on('error',   () => resolve({ status: 0, body: null }));
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: null }); });
      if (method === 'POST') req.write(body || '');
      req.end();
    }
    const basicAuth = 'Basic ' + Buffer.from(auth).toString('base64');
    attempt(basicAuth, false);
  });
}

// A miner's own CGI script returning HTTP 200 with an empty/generic
// body is still meaningfully different from "connection refused" or
// "404 no such endpoint" — this is genuine confirmation, not a guess.
function httpOk(result) {
  return result && result.status >= 200 && result.status < 300;
}

function postJson(url, body) {
  return new Promise(resolve => {
    try {
      const u    = new URL(url);
      const data = JSON.stringify(body);
      const isHttps = u.protocol === 'https:';
      const req  = (isHttps ? https : http).request({
        hostname: u.hostname, port: u.port||(isHttps?443:80),
        path: u.pathname, method: 'POST',
        headers: { 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(data) },
        timeout: 6000,
      }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(d)); });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.write(data); req.end();
    } catch(e) { resolve(null); }
  });
}

function restUrl(path) {
  return SERVER.replace('wss://','https://').replace('ws://','http://').replace(/\/agent$/,'') + path;
}

// ── TCP helpers ────────────────────────────────────────────
function checkPort(ip, port, timeout) {
  return new Promise(resolve => {
    const s = new net.Socket();
    s.setTimeout(timeout || 1500);
    s.on('connect', () => { s.destroy(); resolve(true);  });
    s.on('error',   () => { s.destroy(); resolve(false); });
    s.on('timeout', () => { s.destroy(); resolve(false); });
    try { s.connect(port, ip); } catch(e) { resolve(false); }
  });
}

function cgCmd(ip, cmd) {
  return new Promise(resolve => {
    const s = new net.Socket();
    let d   = '';
    s.setTimeout(4000);
    s.on('connect', () => s.write(JSON.stringify({ command: cmd })));
    s.on('data',  c => d += c.toString());
    s.on('close', () => { try { resolve(JSON.parse(d.replace(/\0/g,''))); } catch(e) { resolve(null); } });
    s.on('error',   () => resolve(null));
    s.on('timeout', () => { s.destroy(); resolve(null); });
    try { s.connect(CGPORT, ip); } catch(e) { resolve(null); }
  });
}

// ── ASIC verification ───────────────────────────────────────
// Only devices responding properly to CGMiner OR known miner HTTP APIs
async function isAsic(ip) {
  // 1. CGMiner API (port 4028) — ONLY ASICs use this
  const ver = await cgCmd(ip, 'version');
  if (ver?.VERSION?.[0] || ver?.STATUS?.[0]) return { via: 'cgminer' };

  // 2. Antminer HTTP API
  const antSum = await httpGet(ip, '/cgi-bin/summary.cgi', 'root:root');
  if (antSum?.SUMMARY || antSum?.summary) return { via: 'antminer-http' };

  // 3. Antminer type endpoint
  const antType = await httpGet(ip, '/cgi-bin/type.cgi', 'root:root');
  if (antType?.type || (typeof antType === 'string' && antType.includes('Antminer'))) return { via: 'antminer-http' };

  // 4. Avalon HTTP (root:root)
  const avaStat = await httpGet(ip, '/api/v1/info', 'root:root');
  if (avaStat?.system_hw_version || avaStat?.version) return { via: 'avalon-http' };

  // 5. Whatsminer HTTP
  const wm = await httpGet(ip, '/cgi-bin/luci/admin/status/overview', 'root:root');
  if (typeof wm === 'string' && (wm.includes('Whatsminer') || wm.includes('MicroBT'))) return { via: 'whatsminer-http' };

  return null; // Not an ASIC
}

// ── Algorithm detection ────────────────────────────────────
function getAlgo(model) {
  const m = (model||'').toLowerCase();
  // Scrypt — any L-series Antminer: L3, L3+, L5, L7, L9, L9 Hydro, L11, L15, L19 etc
  if (/\bl\d/i.test(m) || m.includes('scrypt') || m.includes('litecoin') || m.includes(' ltc')) return 'Scrypt';
  if (m.includes('ka3') || m.includes('kaspa') || m.includes('ika'))             return 'KHeavyHash';
  if (m.includes('d9')  || m.includes('d19')  || m.includes('dash') || m.includes('x11')) return 'X11';
  if (m.includes('hs')  || m.includes('blake') || m.includes('handshake'))        return 'Blake2B';
  if (m.includes('e9')  || m.includes('ethash'))                                   return 'Ethash';
  return 'SHA-256';
}

// ── Hashrate conversion ────────────────────────────────────
function convertHashrate(mhs, algo) {
  if (!mhs || mhs <= 0) return { value: 0, unit: 'TH/s', display: '—' };
  const ghAlgos = ['Scrypt','X11','Equihash','Ethash','Blake2B','KHeavyHash'];
  if (ghAlgos.includes(algo)) {
    const gh = mhs / 1000;
    return { value: parseFloat(gh.toFixed(2)), unit: 'GH/s', display: gh.toFixed(2)+' GH/s' };
  }
  const th = mhs / 1000000;
  return { value: parseFloat(th.toFixed(2)), unit: 'TH/s', display: th.toFixed(2)+' TH/s' };
}

// ── Brand detection ────────────────────────────────────────
function getBrand(model) {
  const m = (model||'').toLowerCase();
  if (m.includes('antminer') || m.includes('bitmain'))              return 'Bitmain';
  if (m.includes('whatsminer') || m.includes('microbt'))            return 'MicroBT';
  if (m.includes('avalon') || m.includes('avalonminer') || m.includes('canaan')) return 'Canaan';
  if (m.includes('goldshell'))   return 'Goldshell';
  if (m.includes('innosilicon')) return 'Innosilicon';
  if (m.includes('jasminer'))    return 'Jasminer';
  if (m.includes('iceriver'))    return 'IceRiver';
  if (m.includes('elphapex') || m.includes('dg1') || m.includes('dg-1')) return 'ElphaPEX';
  return 'Unknown';
}

// ── Model from CGMiner stats ───────────────────────────────
function extractModel(stats, summary) {
  if (!stats?.STATS) return null;
  for (const s of stats.STATS) {
    if (s.Type    && s.Type.length    > 2) return s.Type;
    if (s.type    && s.type.length    > 2) return s.type;
    if (s.Description && s.Description.length > 2) return s.Description;
    // Avalon: look for MM ID pattern
    const mmKey = Object.keys(s).find(k => k.startsWith('MM ID'));
    if (mmKey) {
      // Avalon model is in the stats
      const avModel = Object.keys(s).find(k => k==='Product' || k==='product');
      if (s[avModel]) return s[avModel];
      return 'AvalonMiner';
    }
  }
  return summary?.SUMMARY?.[0]?.Type || null;
}

// ── Fetch MAC address + Serial number ─────────────────────
async function getHardwareIds(ip) {
  let mac = null, serial = null;
  let cachedLog = undefined; // fetched at most once per machine, reused everywhere below

  async function getLog() {
    if (cachedLog === undefined) {
      try { cachedLog = await fetchBootLog(ip); }
      catch(e) { cachedLog = null; }
    }
    return cachedLog;
  }

  // Antminer / most Bitmain-based firmware — get_system_info.cgi has the MAC
  const sysInfo = await httpGet(ip, '/cgi-bin/get_system_info.cgi', 'root:root');
  if (sysInfo && typeof sysInfo === 'object') {
    mac    = sysInfo.macaddr || sysInfo.mac || sysInfo.MAC || null;
    serial = sysInfo.minersn || sysInfo.serialno || sysInfo.sn || sysInfo.SerialNo
           || sysInfo.serial_number || sysInfo.miner_sn || null;
  }

  // Serial number is often on get_miner_conf.cgi instead
  if (!serial) {
    const conf = await httpGet(ip, '/cgi-bin/get_miner_conf.cgi', 'root:root');
    if (conf && typeof conf === 'object') {
      serial = conf.minersn || conf.serialno || conf.sn || null;
    }
  }

  // Try get_network_info.cgi — some Bitmain firmware exposes serial here
  if (!serial) {
    const netInfo = await httpGet(ip, '/cgi-bin/get_network_info.cgi', 'root:root');
    if (netInfo && typeof netInfo === 'object') {
      serial = netInfo.minersn || netInfo.serialno || netInfo.sn || null;
    }
  }

  // Whatsminer — the LuCI status page is HTML, not JSON, so we can't
  // read wmInfo.mac like a normal object. MAC/serial must be pulled out
  // of the page text with a pattern match instead.
  if (!mac || !serial) {
    const wmInfo = await httpGet(ip, '/cgi-bin/luci/admin/status/overview', 'root:root');
    if (typeof wmInfo === 'string') {
      if (!mac) {
        const macMatch = wmInfo.match(/([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}/);
        if (macMatch) mac = macMatch[0];
      }
      if (!serial) {
        const snMatch = wmInfo.match(/\bS\/?N\s*[:=]\s*([A-Za-z0-9]{6,})/i)
                       || wmInfo.match(/serial\s*[:=]\s*([A-Za-z0-9]{6,})/i);
        if (snMatch) serial = snMatch[1];
      }
    } else if (wmInfo && typeof wmInfo === 'object') {
      mac    = mac    || wmInfo.mac      || wmInfo.macaddr    || null;
      serial = serial || wmInfo.sn       || wmInfo.serial_no  || null;
    }
  }

  // Avalon — separate info endpoint
  if (!mac || !serial) {
    const avaInfo = await httpGet(ip, '/api/v1/info', 'root:root');
    if (avaInfo) {
      mac    = mac    || avaInfo.mac        || null;
      serial = serial || avaInfo.serial_no  || avaInfo.sn || null;
    }
  }

  // Fallback: try /cgi-bin/status.cgi (some firmware variants)
  if (!mac || !serial) {
    const status = await httpGet(ip, '/cgi-bin/status.cgi', 'root:root');
    if (status) {
      mac    = mac    || status.mac    || null;
      serial = serial || status.serial || status.sn || null;
    }
  }

  // Last resort — fetch the boot/system log ONCE and pull whatever we
  // can from it. Formats confirmed so far:
  //   L-series:   "droa miner sn: DGAHFFUBEJAAE02R5"
  //   S21 Pro:    "type: Antminer S21 Pro sn :DGAHFKUBDJFAE08XA mac:"
  //               "Miner sn: DGAHFKUBDJFAE08XA"
  //   WhatsMiner: "MAC: CE:0B:16:00:24:C0, Firmware version: ..."
  if (!mac || !serial) {
    const logText = await getLog();
    if (typeof logText === 'string') {
      if (!serial) {
        const snMatch = logText.match(/droa miner sn:\s*([A-Za-z0-9]+)/i)
                      || logText.match(/miner sn\s*:\s*([A-Za-z0-9]+)/i)
                      || logText.match(/\bsn\s*:\s*([A-Za-z0-9]{8,})/i);
        if (snMatch) { serial = snMatch[1]; console.log(`[SN] ${ip} → found via boot log: ${serial}`); }
      }
      if (!mac) {
        const macMatch = logText.match(/MAC\s*:\s*([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})/i);
        if (macMatch) { mac = macMatch[1]; console.log(`[MAC] ${ip} → found via boot log: ${mac}`); }
      }
    }
  }

  const cleanMac = mac ? mac.toUpperCase().replace(/[^0-9A-F]/g, '').replace(/(.{2})(?=.)/g, '$1:') : null;
  console.log('[HWID] ' + ip + ' → MAC: ' + (cleanMac || 'not found') + ' | Serial: ' + (serial || 'not found'));
  return { mac: cleanMac, serial: serial || null, logText: cachedLog };
}

// ── Full miner info ────────────────────────────────────────
async function getMinerInfo(ip) {
  // Parallel API calls via CGMiner TCP + hardware IDs via HTTP
  const [summary, stats, devs, pools, hwIds, httpPools] = await Promise.all([
    cgCmd(ip, 'summary'),
    cgCmd(ip, 'stats'),
    cgCmd(ip, 'devs'),
    cgCmd(ip, 'pools'),
    getHardwareIds(ip),
    // ElphaPEX confirmed directly from its own web dashboard: the same
    // pool/worker/model data cgminer's TCP API is SUPPOSED to expose on
    // port 4028 is also served here over plain HTTP, as
    // {"POOLS":[{"user":...,"url":...,"status":...}],"INFO":{"type":
    // "DG1+","dev_sn":...}} — note the lowercase field names, unlike
    // stock cgminer's capitalized ones. Fetched unconditionally (cheap,
    // and brand isn't known yet at this point) and only relied on below
    // when the TCP response doesn't already have what's needed.
    httpGet(ip, '/cgi-bin/pools.cgi'),
  ]);

  let model = extractModel(stats, summary);

  // A valid model name is short plaintext — reject HTML error pages,
  // connection error strings, or anything that isn't a real model string
  function isValidModel(m) {
    if (!m || typeof m !== 'string') return false;
    const s = m.trim();
    if (s.length < 3 || s.length > 60) return false;
    if (/<[a-z]|not found|error|refused|forbidden|unauthorized|timeout|http\//i.test(s)) return false;
    return true;
  }

  // ElphaPEX's pools.cgi (see httpPools above) carries a clean, structured
  // "INFO" block with the model right on it — e.g. {"type":"DG1+",
  // "dev_sn":"...","hw_version":"DG1+_HW_V1.0"}. Far more reliable than
  // scraping the boot log for it, so it's tried before that fallback.
  if (!isValidModel(model) && httpPools?.INFO?.type) {
    const infoCandidate = 'ElphaPEX ' + httpPools.INFO.type;
    if (isValidModel(infoCandidate)) model = infoCandidate;
  }

  // Fallback: try Antminer HTTP for model
  if (!isValidModel(model)) {
    const typeData = await httpGet(ip, '/cgi-bin/type.cgi', 'root:root');
    let candidate = null;
    if (typeof typeData === 'string') candidate = typeData.trim();
    else if (typeData?.type) candidate = typeData.type;
    if (isValidModel(candidate)) model = candidate;

    // Avalon HTTP fallback
    if (!isValidModel(model)) {
      const avaInfo = await httpGet(ip, '/api/v1/info', 'root:root');
      const avaCandidate = avaInfo?.system_hw_version ? 'AvalonMiner ' + avaInfo.system_hw_version : null;
      if (isValidModel(avaCandidate)) model = avaCandidate;
    }

    // Model from boot log — reuses the SAME log fetch that getHardwareIds()
    // already did (via hwIds.logText) when it has it; otherwise fetches
    // it directly rather than skipping this fallback. getHardwareIds()
    // only pulls the log when mac/serial are BOTH still missing, so a
    // machine whose mac/serial were found some other way never got a
    // log fetch at all, silently disabling this fallback for it. Handles
    // WhatsMiner + ElphaPEX formats:
    //   WhatsMiner: "miner_type=M50VH50"
    //   ElphaPEX:   "Sep 12 19:36:48 DG1+ user.info health: ..."
    if (!isValidModel(model)) {
      let logText = (typeof hwIds?.logText === 'string') ? hwIds.logText : null;
      if (logText === null) {
        try { logText = await fetchBootLog(ip); } catch(e) { logText = null; }
      }
      if (typeof logText === 'string') {
        const wmMatch = logText.match(/miner_type\s*=\s*([A-Za-z0-9+]+)/i);
        if (wmMatch) {
          const wmCandidate = 'WhatsMiner ' + wmMatch[1];
          if (isValidModel(wmCandidate)) model = wmCandidate;
        }
        if (!isValidModel(model)) {
          const epMatch = logText.match(/^\w+\s+\d+\s+[\d:]+\s+(DG\d\+?|ElphaPEX\S*)\s+\S+\.\S+\s/im);
          if (epMatch) {
            const epCandidate = 'ElphaPEX ' + epMatch[1];
            if (isValidModel(epCandidate)) model = epCandidate;
          }
        }
      }
    }
  }

  if (!isValidModel(model)) model = 'Unknown';

  const algo  = getAlgo(model);
  const brand = getBrand(model);

  // Serial fallback — same reasoning as the model fallback above: pools.cgi's
  // INFO block has it directly (dev_sn) when the generic hwIds lookups (which
  // never checked this endpoint) come up empty.
  if (!hwIds.serial && httpPools?.INFO?.dev_sn) hwIds.serial = httpPools.INFO.dev_sn;

  // Hashrate from summary
  const s      = summary?.SUMMARY?.[0] || {};
  let   rawMhs = parseFloat(s['MHS 5s'] || s['MHS av'] || (s['GHS 5s']||0)*1000 || (s['THS 5s']||0)*1e6 || 0);

  // ElphaPEX fallback — its cgminer 'summary' doesn't expose hashrate in
  // any of the field names read above, so the ONLY place it's available
  // is a line in the boot log. getHardwareIds() only fetches that log
  // as a LAST RESORT when mac/serial are still missing after everything
  // else — on a machine where the generic mac/serial lookups happen to
  // succeed (fairly common), the log is never fetched at all, and this
  // fallback silently had nothing to read, leaving hashrate at 0 and
  // the machine looking offline even though it was hashing fine. Fetch
  // the log directly here when that happened, instead of only ever
  // reusing whatever getHardwareIds() already had cached.
  if (!rawMhs || rawMhs <= 0) {
    let logForHr = (typeof hwIds?.logText === 'string') ? hwIds.logText : null;
    if (logForHr === null) {
      try { logForHr = await fetchBootLog(ip); } catch(e) { logForHr = null; }
    }
    if (typeof logForHr === 'string') {
      const hrMatch = logForHr.match(/hashrate by nonce is:\s*([\d.]+)\s*Mhash\/s/i);
      if (hrMatch) rawMhs = parseFloat(hrMatch[1]);
    }
  }

  const hr = convertHashrate(rawMhs, algo);

  // Temperature — boards first, then summary
  const boardTemps = (devs?.DEVS || [])
    .flatMap(d => [d.Temperature, d['Temp'], d['temp']])
    .map(t => parseFloat(t||0)).filter(t => t > 30 && t < 120);
  
  const statsTemps = (stats?.STATS || []).flatMap(st => {
    const temps = [];
    ['temp1','temp2','temp3','temp4','temp5','temp6','temp7','temp8',
     'temp_chip1','temp_chip2','temp_chip3','temp_pcb1','temp_pcb2','temp_pcb3',
     'temp2_1','temp2_2','temp2_3'].forEach(k => {
      const t = parseFloat(st[k]||0);
      if (t > 30 && t < 120) temps.push(t);
    });
    return temps;
  });

  const allTemps = [...boardTemps, ...statsTemps];
  const temp = allTemps.length ? Math.round(Math.max(...allTemps)) : Math.round(parseFloat(s.Temperature||s.temp||0));

  // Fan speed
  const st0 = stats?.STATS?.[0] || {};
  const fanValues = ['fan1','fan2','fan3','fan4','Fan Speed In','Fan Speed Out','fan_num']
    .map(k => parseInt(st0[k]||devs?.DEVS?.[0]?.[k]||0)).filter(v=>v>0);
  const fan = fanValues.length ? Math.max(...fanValues) : 0;

  // Pool info — check all configured pools, prefer the active one.
  // Some firmware (confirmed on ElphaPEX, via its own pools.cgi) uses
  // entirely lowercase field names — user/url/status/priority — instead
  // of stock cgminer's User/URL/Status/Priority/Stratum. Every read below
  // checks both. Also falls back from the TCP `pools` response to the
  // HTTP `httpPools` one when the TCP side came back empty — on units
  // where port 4028 doesn't answer 'pools' usefully at all, the HTTP
  // endpoint (proven working against this exact firmware) still does.
  const poolField = (p, ...names) => { for (const n of names) { if (p && p[n] !== undefined && p[n] !== '') return p[n]; } return undefined; };
  const poolsSrc  = (pools?.POOLS?.length ? pools : null) || (httpPools?.POOLS?.length ? httpPools : null) || pools || httpPools || {};
  const allPools  = poolsSrc?.POOLS || [];
  const activePool = allPools.find(p => poolField(p,'Stratum','stratum') === true || poolField(p,'Stratum Active','stratum active') === true)
                   || allPools.find(p => poolField(p,'Status','status') === 'Alive')
                   || allPools[0] || {};
  const power = parseInt(st0.power || st0.Power || s.Power || 0);
  const uptime = formatUptime(parseInt(s.Elapsed||0));

  // Full worker ID as configured on the miner — includes wallet/worker suffix.
  const userField = p => poolField(p, 'User','user','Username','username','User Name');
  const fullWorkerId = userField(activePool) || allPools.map(userField).find(u => u && u !== '') || '—';

  // TEMP DIAGNOSTIC — the v1.1.29 pool/model fix isn't showing up on the
  // Workers page despite looking correct against the raw pools.cgi JSON.
  // Pinned to this one known-problem IP (not brand, which was the trap
  // last time) so it fires unconditionally and shows exactly which stage
  // of the pipeline actually has the data and which doesn't. Remove once
  // this is root-caused.
  if (ip === '19.3.19.46') {
    console.log(`[EP-DEBUG2] ${ip} httpPools raw:`, JSON.stringify(httpPools));
    console.log(`[EP-DEBUG2] ${ip} pools(tcp) raw:`, JSON.stringify(pools));
    console.log(`[EP-DEBUG2] ${ip} poolsSrc.POOLS.length=${allPools.length} activePool=`, JSON.stringify(activePool));
    console.log(`[EP-DEBUG2] ${ip} fullWorkerId="${fullWorkerId}" model="${model}" brand="${brand}"`);
  }


  // HW errors and shares
  const accepted  = parseInt(s.Accepted||0);
  const rejected  = parseInt(s.Rejected||0);
  const hwErrors  = parseInt(s['Hardware Errors']||0);
  const boards    = (devs?.DEVS||[]).length;

  // A machine that responds on the network but reports zero hashrate
  // isn't actually mining — treat it the same as offline rather than
  // showing it as a healthy connected machine.
  const isActuallyMining = hr.value > 0;

  return {
    ip, model, brand, algo,
    hashrate:    hr.value,
    hr_unit:     hr.unit,
    hr_display:  isActuallyMining ? hr.display : '—',
    temp, fan, power, uptime,
    pool:        poolField(activePool,'URL','url')     || '—',
    worker:      fullWorkerId,
    worker_id:   fullWorkerId,   // full string exactly as configured on the miner
    pool_status: poolField(activePool,'Status','status')  || '—',
    pools:       allPools.map(p => ({
      url:      poolField(p,'URL','url'),
      user:     userField(p),
      status:   poolField(p,'Status','status'),
      priority: poolField(p,'Priority','priority'),
    })),
    mac:         hwIds.mac    || null,   // machine's network MAC address
    serial:      hwIds.serial || null,   // manufacturer serial number
    accepted, rejected, hw_errors: hwErrors,
    boards,
    status: isActuallyMining ? 'online' : 'offline',
    source: 'cgminer',
  };
}

function formatUptime(secs) {
  if (!secs) return '—';
  const d=Math.floor(secs/86400), h=Math.floor((secs%86400)/3600), m=Math.floor((secs%3600)/60);
  return d>0?`${d}d ${h}h`:h>0?`${h}h ${m}m`:`${m}m`;
}

// ── Subnet to IPs ──────────────────────────────────────────
function subnetToIPs(input) {
  input = (input || '').trim();
  try {
    // Format: 192.168.70.0/24 (CIDR)
    if (input.includes('/')) {
      const [base, bits] = input.split('/');
      const mask  = ~((1 << (32 - parseInt(bits))) - 1);
      const p     = base.split('.').map(Number);
      const base32= (p[0]<<24)|(p[1]<<16)|(p[2]<<8)|p[3];
      const net32 = base32 & mask;
      const size  = Math.min(Math.pow(2, 32 - parseInt(bits)) - 2, 254);
      return Array.from({length: size}, (_, i) => {
        const n = net32 + i + 1;
        return [(n>>24)&255,(n>>16)&255,(n>>8)&255,n&255].join('.');
      });
    }
    // Format: 192.168.70.1-255 or 192.168.70.1-192.168.70.255
    if (input.includes('-')) {
      const parts = input.split('-');
      const startParts = parts[0].trim().split('.');
      const endPart    = parts[1].trim();
      // If end is just a number (last octet)
      const endOctet   = endPart.includes('.') ? parseInt(endPart.split('.').pop()) : parseInt(endPart);
      const startOctet = parseInt(startParts[3]);
      const prefix     = startParts.slice(0,3).join('.');
      const ips = [];
      for (let i = startOctet; i <= endOctet; i++) ips.push(`${prefix}.${i}`);
      return ips;
    }
    // Format: 192.168.70 (assume .1-254)
    if (input.split('.').length === 3) {
      return Array.from({length: 254}, (_, i) => `${input}.${i + 1}`);
    }
    // Single IP
    return [input];
  } catch(e) {
    console.error('[SCAN] subnetToIPs error:', e.message, 'input:', input);
    return [];
  }
}

// ── Fetch miner log ────────────────────────────────────────
// Does this look like real content, or like the miner's error page?
// A firmware that doesn't have an endpoint answers with an HTML page
// rather than a clean failure, and that page is a perfectly ordinary
// non-empty string — so "did we get something back" is not a usable
// test on its own.
function looksLikeRealContent(v) {
  if (!v) return false;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  const s = String(v).trim();
  if (s.length < 20) return false;
  // An HTML document here means a login page, a 404, or an error page.
  if (/^\s*<(!doctype|html|head|body)/i.test(s)) return false;
  if (/401 unauthorized|404 not found|403 forbidden|bad request/i.test(s)) return false;
  return true;
}

// Collect from EVERY endpoint that answers rather than stopping at the
// first, because which one carries the useful detail varies by firmware
// — and a stop-at-first-truthy rule used to return whichever error page
// happened to come back first.
async function fetchMinerLog(ip) {
  const parts = [];

  // Real syslog text first — this is what someone asking for "the log"
  // actually wants. It used to be tried LAST, behind two endpoints that
  // return JSON status instead.
  const syslog = await httpGet(ip, '/cgi-bin/log.cgi', 'root:root');
  if (looksLikeRealContent(syslog)) {
    parts.push('===== SYSTEM LOG (log.cgi) =====\n'
      + (typeof syslog === 'string' ? syslog : JSON.stringify(syslog, null, 2)));
  }

  const sysInfo = await httpGet(ip, '/cgi-bin/get_system_info.cgi', 'root:root');
  if (looksLikeRealContent(sysInfo)) {
    parts.push('===== SYSTEM INFO (get_system_info.cgi) =====\n'
      + (typeof sysInfo === 'string' ? sysInfo : JSON.stringify(sysInfo, null, 2)));
  }

  // CGMiner's own API, which answers on port 4028 even when the web
  // interface is unhappy — often the only thing that responds on a
  // miner that's in trouble, which is exactly when a log is wanted.
  const check = await cgCmd(ip, 'stats');
  if (looksLikeRealContent(check)) {
    parts.push('===== CGMINER STATS (port 4028) =====\n' + JSON.stringify(check, null, 2));
  }

  if (!parts.length) return null;
  return 'Miner ' + ip + ' — collected ' + new Date().toISOString() + '\n\n' + parts.join('\n\n');
}

// ── Fetch the REAL boot/system log text ────────────────────
// fetchMinerLog() above prioritizes get_system_info.cgi's JSON, which
// is fine for the View/Download Logs UI feature but does NOT contain
// the serial/model/MAC patterns we need to parse (those only appear
// in the actual syslog text from log.cgi). This is a separate function
// specifically for that raw log text — go straight to log.cgi, skip
// the JSON-returning endpoints entirely.
async function fetchBootLog(ip) {
  const log = await httpGet(ip, '/cgi-bin/log.cgi', 'root:root');
  if (typeof log === 'string' && log.length > 50) return log;

  const check = await cgCmd(ip, 'check');
  if (typeof check === 'string' && check.length > 50) return check;

  return null;
}

// ── Scan network ───────────────────────────────────────────
async function scanMultipleSubnets(sessionId, subnets, ports, timeout) {
  for (let i = 0; i < subnets.length; i++) {
    const subnet = subnets[i].trim();
    if (!subnet) continue;
    console.log(`[SCAN] Subnet ${i+1}/${subnets.length}: ${subnet}`);
    // Tell backend which subnet we're scanning now
    await postJson(restUrl('/api/scanner/result'), {
      session_id: sessionId, current_subnet: subnet,
      scanned: 0, total: 0, progress: 0, done: false, found: [],
    }).catch(()=>{});
    const isLast = (i === subnets.length - 1);
    await scanNetwork(subnet, ports, timeout, sessionId, isLast);
    // Small pause between subnets
    if (i < subnets.length - 1) await new Promise(r => setTimeout(r, 500));
  }
}

async function scanNetwork(subnet, ports, timeout, sessionId, isLast=true) {
  subnet  = subnet  || SUBNET;
  ports   = ports   || [4028, 80];
  timeout = timeout || 2000;
  const ips   = subnetToIPs(subnet);
  const total = ips.length;
  const BATCH = 20;
  let scanned = 0, found = 0;

  console.log(`\n[SCAN] ▶ ${subnet} — ${total} IPs (ASIC-only filter active)`);
  await postJson(restUrl('/api/scanner/result'), {
    session_id: sessionId, scanned:0, total, progress:0, done:false, found:[]
  });

  for (let i = 0; i < ips.length; i += BATCH) {
    const batch = ips.slice(i, i + BATCH);
    await Promise.all(batch.map(async ip => {
      // Quick TCP check first
      const port4028open = await checkPort(ip, 4028, timeout);
      const port80open   = !port4028open && await checkPort(ip, 80, timeout);
      
      if (port4028open || port80open) {
        // Verify it is actually an ASIC (not PC/router/phone)
        const asicCheck = await isAsic(ip);
        if (asicCheck) {
          found++;
          const info = await getMinerInfo(ip);
          console.log(`[SCAN] ✓ ASIC: ${ip} — ${info.brand} ${info.model} | ${info.hr_display} | ${info.temp}°C`);
          send({ type: 'scan_found', session_id: sessionId, miner: info });
          await postJson(restUrl('/api/scanner/result'), { session_id: sessionId, found: [info] });
        } else {
          console.log(`[SCAN] ✗ Skip: ${ip} — not an ASIC`);
        }
      }
      scanned++;
    }));

    const progress = Math.round((scanned/total)*100);
    send({ type:'scan_progress', session_id:sessionId, total, scanned, found, progress, done:false });
    await postJson(restUrl('/api/scanner/result'), { session_id:sessionId, scanned, total, progress, done:false, found:[] });
  }

  console.log(`[SCAN] ■ Done — ${found} ASICs found in ${subnet}`);
  send({ type:'scan_progress', session_id:sessionId, total, scanned:total, found, progress:100, done:isLast });
  await postJson(restUrl('/api/scanner/result'), { session_id:sessionId, scanned:total, total, progress:100, done:isLast, found:[] });
}

// ── Poll miners ────────────────────────────────────────────
let pollInProgress = false;
// ── ARP-based MAC lookup ────────────────────────────────────────
// Many miners don't expose their MAC through their web API at all
// (agent logs show plenty of "MAC: not found"). But the agent sits on
// the same LAN, so the operating system's own ARP table already knows
// the MAC of every device it has actually talked to. This gives a
// stable hardware ID for machines whose firmware won't tell us one —
// which matters enormously on DHCP, where the IP address changes and
// is therefore useless as a permanent identity.
function runArp() {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(''), 4000);
    execFile('arp', ['-a'], { timeout: 4000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      clearTimeout(timer);
      resolve(err ? '' : stdout);
    });
  });
}

function findMacInArpOutput(output, ip) {
  for (const line of output.split('\n')) {
    // Match the IP as a whole token — a bare includes() would match
    // 19.3.19.1 inside 19.3.19.15 and return the wrong device's MAC.
    if (!new RegExp('(^|[^0-9.])' + ip.replace(/\./g, '\\.') + '([^0-9.]|$)').test(line)) continue;
    const macMatch = line.match(/([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}/);
    if (macMatch) return macMatch[0].toUpperCase().replace(/-/g, ':');
  }
  return null;
}

// Fill in missing MACs from the ARP table, with a critical safety guard.
// If miners sit on a subnet the agent reaches THROUGH A ROUTER, the ARP
// table returns the ROUTER's MAC for every one of them — identical for
// all. Using that as identity would collapse an entire subnet into a
// single machine record. So any MAC that turns up for more than one IP
// is treated as shared network infrastructure and discarded outright.
async function enrichMacsFromArp(miners) {
  const needMac = miners.filter(m => !m.mac);
  if (needMac.length === 0) return;

  const arp = await runArp();
  if (!arp) { console.log('[ARP] Table unavailable — skipping MAC enrichment this cycle'); return; }

  const candidates = new Map(); // ip -> mac
  const macCount   = new Map(); // mac -> how many IPs claim it
  for (const m of needMac) {
    const mac = findMacInArpOutput(arp, m.ip);
    if (!mac) continue;
    candidates.set(m.ip, mac);
    macCount.set(mac, (macCount.get(mac) || 0) + 1);
  }

  // Also refuse any MAC already reported directly by a different miner
  const claimed = new Set(miners.filter(m => m.mac).map(m => m.mac.toUpperCase()));

  let applied = 0, rejected = 0;
  for (const m of needMac) {
    const mac = candidates.get(m.ip);
    if (!mac) continue;
    if (macCount.get(mac) > 1 || claimed.has(mac)) { rejected++; continue; }
    m.mac = mac;
    m.mac_source = 'arp';
    applied++;
  }
  if (applied || rejected) {
    console.log(`[ARP] MACs recovered: ${applied}${rejected ? ` (${rejected} rejected as shared/router MACs)` : ''}`);
  }
}

async function pollMiners() {
  // Prevent overlapping cycles — scanning multiple subnets can take
  // longer than the poll interval on a large farm, and running two
  // polls at once would double up network load for no benefit.
  if (pollInProgress) { console.log('[POLL] Previous cycle still running — skipping this tick'); return; }
  pollInProgress = true;
  try {
    await doPollMiners();
  } finally {
    pollInProgress = false;
  }
}

async function doPollMiners() {
  // Poll EVERY configured subnet, not just the first one — a farm
  // with multiple subnets (e.g. "192.168.70.0/24,192.168.44.0/24")
  // must have every machine on every subnet checked each cycle,
  // otherwise machines on the 2nd+ subnet get wrongly marked offline
  // even though they're actually online.
  const live  = [];
  const BATCH = 25;

  for (const subnet of SUBNETS) {
    const ips = subnetToIPs(subnet);
    for (let i = 0; i < ips.length; i += BATCH) {
      const batch = ips.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(async ip => {
        if (!await checkPort(ip, CGPORT, 1500)) return null;
        return getMinerInfo(ip).catch(() => null);
      }));
      live.push(...results.filter(Boolean));
    }
  }

  if (live.length > 0) {
    // Recover MACs for machines whose firmware didn't report one, so
    // the backend has a stable hardware ID to recognise them by after
    // a DHCP address change. Failure here is non-fatal — worst case
    // those machines simply keep their previous identity behaviour.
    try { await enrichMacsFromArp(live); } catch(e) { console.log('[ARP] enrichment error (non-fatal):', e.message); }

    console.log(`[POLL] ${live.length} miners online across ${SUBNETS.length} subnet(s)`);
    send({ type:'poll_result', miners:live, miner_count:live.length });
  }
}

// ── Send ───────────────────────────────────────────────────
function send(payload) {
  if (ws?.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(payload)); } catch(e) {}
  }
}

// ── Connect ────────────────────────────────────────────────
// ── Poll Lanli RS485 cabinets ──────────────────────────────
// ── Web UI tunnel — proxy a browser request to a miner's local
// web dashboard, and send the raw response back to the backend
// over the same WebSocket connection. ──────────────────────
// ── CGMiner API responses can be "valid JSON" while still meaning
// "command rejected" — e.g. {"STATUS":[{"STATUS":"E","Msg":"Invalid
// command"}]}. Checking "did we get JSON back" isn't the same as
// checking "did the miner actually confirm success" — this caused
// action buttons to report success while doing nothing on the miner.
function cgSuccess(r) {
  const s = r?.STATUS?.[0]?.STATUS;
  return s === 'S' || s === 'I'; // Success or Informational
}
function cgErrorMsg(r) {
  return r?.STATUS?.[0]?.Msg || null;
}

// ── Miner control actions — restart, reboot, sleep, wake, led, etc ──
// These run HERE on the agent (which has real LAN access to the miner)
// rather than on the cloud backend, which has no path to a private
// farm-network IP at all. Same reasoning as the Web UI tunnel.
async function handleActionRequest(msg) {
  const { request_id, ip, action, params } = msg;
  console.log(`[ACTION] Received: ${action} → ${ip} (request_id: ${request_id})`);

  async function reply(ok, extra) {
    console.log(`[ACTION] Replying: ${action} → ${ip} | ok=${ok}` + (extra?.error ? ` | error: ${extra.error}` : ''));
    send({ type: 'action_response', request_id, ok, ...(extra || {}) });
  }

  try {
    switch (action) {
      case 'restart': {
        const r = await cgCmd(ip, 'restart');
        console.log(`[ACTION-DEBUG] ${ip} restart cgminer response:`, JSON.stringify(r).slice(0, 300));
        if (!cgSuccess(r)) {
          // 'restart' via the CGMiner TCP API isn't supported by every
          // firmware build — fall back to the miner's own hardware
          // "restart mining software" HTTP endpoint instead.
          const httpResult = await httpPost(ip, 80, '/cgi-bin/reboot.cgi', JSON.stringify({ mode: 'restart' }), 5000);
          console.log(`[ACTION-DEBUG] ${ip} restart HTTP fallback: status=${httpResult.status} body=${JSON.stringify(httpResult.body).slice(0,300)}`);
          if (httpOk(httpResult)) await reply(true, { message: 'Mining software restart sent (via HTTP fallback)' });
          else await reply(false, { error: 'Miner rejected the command (cgminer: ' + (cgErrorMsg(r) || 'no reply') + ', HTTP status: ' + httpResult.status + ')' });
        } else {
          await reply(true, { message: 'Mining software restart sent' });
        }
        break;
      }
      case 'reboot': {
        let r = await cgCmd(ip, 'restart');
        console.log(`[ACTION-DEBUG] ${ip} reboot cgminer response:`, JSON.stringify(r).slice(0, 300));
        if (!cgSuccess(r)) {
          const httpResult = await httpPost(ip, 80, '/cgi-bin/reboot.cgi', '', 5000);
          console.log(`[ACTION-DEBUG] ${ip} reboot HTTP fallback: status=${httpResult.status} body=${JSON.stringify(httpResult.body).slice(0,300)}`);
          if (httpOk(httpResult)) await reply(true, { message: 'Hard reboot sent (via HTTP fallback)' });
          else await reply(false, { error: 'Miner rejected the command (cgminer: ' + (cgErrorMsg(r) || 'no reply') + ', HTTP status: ' + httpResult.status + ')' });
        } else {
          await reply(true, { message: 'Hard reboot sent' });
        }
        break;
      }
      case 'sleep': {
        let r = await cgCmd(ip, 'zero');
        console.log(`[ACTION-DEBUG] ${ip} sleep cgminer response:`, JSON.stringify(r).slice(0, 300));
        if (!cgSuccess(r)) {
          const httpResult = await httpPost(ip, 80, '/cgi-bin/set_miner_conf.cgi', JSON.stringify({ sleep: 1 }), 5000);
          console.log(`[ACTION-DEBUG] ${ip} sleep HTTP fallback: status=${httpResult.status} body=${JSON.stringify(httpResult.body).slice(0,300)}`);
          if (httpOk(httpResult)) await reply(true, { message: 'Sleep mode requested (via HTTP fallback)' });
          else await reply(false, { error: 'Miner rejected the command (cgminer: ' + (cgErrorMsg(r) || 'no reply') + ', HTTP status: ' + httpResult.status + ')' });
        } else {
          await reply(true, { message: 'Sleep mode requested' });
        }
        break;
      }
      case 'wake': {
        let r = await cgCmd(ip, 'resume');
        console.log(`[ACTION-DEBUG] ${ip} wake cgminer response:`, JSON.stringify(r).slice(0, 300));
        if (!cgSuccess(r)) {
          const httpResult = await httpPost(ip, 80, '/cgi-bin/set_miner_conf.cgi', JSON.stringify({ sleep: 0 }), 5000);
          console.log(`[ACTION-DEBUG] ${ip} wake HTTP fallback: status=${httpResult.status} body=${JSON.stringify(httpResult.body).slice(0,300)}`);
          if (httpOk(httpResult)) await reply(true, { message: 'Wake-up requested (via HTTP fallback)' });
          else await reply(false, { error: 'Miner rejected the command (cgminer: ' + (cgErrorMsg(r) || 'no reply') + ', HTTP status: ' + httpResult.status + ')' });
        } else {
          await reply(true, { message: 'Wake-up requested' });
        }
        break;
      }
      case 'led': {
        const r = await httpPost(ip, 80, '/cgi-bin/blink.cgi', JSON.stringify({ blink: params?.on ? 1 : 0 }), 5000);
        if (httpOk(r)) await reply(true, { message: 'LED command sent' });
        else await reply(false, { error: 'Miner did not accept the LED command (HTTP status: ' + r.status + ')' });
        break;
      }
      case 'chiptest': {
        // No universal ASIC self-test command exists across firmware —
        // 'check' is the closest CGMiner diagnostic available generically.
        const r = await cgCmd(ip, 'check');
        await reply(cgSuccess(r), { message: 'Diagnostic check requested', result: r });
        break;
      }
      case 'setworkerid': {
        const body = JSON.stringify({ pools: [{ url: params.pool_url, user: params.new_user, pass: 'x' }] });
        const r = await httpPost(ip, 80, '/cgi-bin/set_miner_conf.cgi', body, 5000);
        if (httpOk(r)) await reply(true, { message: 'Worker ID updated' });
        else await reply(false, { error: 'Miner rejected the change (HTTP status: ' + r.status + ')' });
        break;
      }
      case 'setpool': {
        const pools = [{ url: params.pool_url, user: params.pool_user, pass: params.pool_pass || 'x' }];
        if (params.pool_url2) pools.push({ url: params.pool_url2, user: params.pool_user2 || params.pool_user, pass: 'x' });
        if (params.pool_url3) pools.push({ url: params.pool_url3, user: params.pool_user3 || params.pool_user, pass: 'x' });
        const r = await httpPost(ip, 80, '/cgi-bin/set_miner_conf.cgi', JSON.stringify({ pools }), 5000);
        if (httpOk(r)) await reply(true, { message: 'Pool configuration updated' });
        else await reply(false, { error: 'Miner rejected the change (HTTP status: ' + r.status + ')' });
        break;
      }
      case 'overclock': {
        const body = JSON.stringify({ 'bitmain-work-mode': params.mode, freq: params.freq_pct, 'fan-speed': params.fan_pct });
        const r = await httpPost(ip, 80, '/cgi-bin/set_miner_conf.cgi', body, 5000);
        if (httpOk(r)) await reply(true, { message: 'Power settings applied' });
        else await reply(false, { error: 'Miner rejected the change (HTTP status: ' + r.status + ')' });
        break;
      }
      case 'factoryreset': {
        // Confirmed directly from this exact firmware's own dashboard code:
        // the real endpoint is reset_conf.cgi, not factory_reset.cgi — our
        // httpPost() will auto-retry as GET if it also rejects POST like
        // reboot.cgi does, same pattern already confirmed working.
        const r = await httpPost(ip, 80, '/cgi-bin/reset_conf.cgi', JSON.stringify({ reset: 1 }), 5000);
        if (httpOk(r)) await reply(true, { message: 'Factory reset initiated' });
        else await reply(false, { error: 'Miner rejected the command (HTTP status: ' + r.status + ')' });
        break;
      }
      case 'firmware': {
        const r = await httpPost(ip, 80, '/cgi-bin/upgrade.cgi', JSON.stringify({ url: params.firmware_url }), 8000);
        if (httpOk(r)) await reply(true, { message: 'Firmware upgrade started — do NOT power off, takes 3-5 minutes' });
        else await reply(false, { error: 'Miner rejected the upgrade (HTTP status: ' + r.status + ')' });
        break;
      }
      case 'fetchlogs':
      case 'downloadlogs': {
        const logText = await fetchBootLog(ip);
        if (logText) await reply(true, { logs: logText });
        else await reply(false, { error: 'Could not retrieve logs from this miner' });
        break;
      }
      default:
        await reply(false, { error: `Unknown action: ${action}` });
    }
  } catch(e) {
    await reply(false, { error: e.message });
  }
}

// ── Per-IP request queue for the Web UI tunnel ──────────────────
// Many embedded miner web servers (this class of firmware included)
// can only handle ONE connection at a time. The miner's own dashboard
// commonly refreshes itself by firing several data requests (pools,
// stats, warnings, system info) all at the same instant — if we send
// all of those to the miner simultaneously, its tiny web server
// rejects most of them outright, which looked like a genuine
// connection failure (502) even though the miner was perfectly
// reachable. Queuing requests per-IP so only one is ever in flight
// to a given miner at a time avoids this entirely.
// Requests to one miner run a few at a time, not strictly one after
// another. Serialising them completely was safe but made a large page
// pathologically slow: with dozens of files queued, the ones at the
// back waited so long that the backend had already given up on them
// before they even started, so the tail of every big page failed.
//
// The http.Agent below caps ACTUAL sockets per miner, so this limit
// governs how many requests are in flight, while the socket pool is
// what protects the miner's small web server from being flooded.
const WEBUI_CONCURRENCY = 3;
const webuiActive  = new Map(); // ip -> number of requests in flight
const webuiWaiting = new Map(); // ip -> array of queued starters

function queueForIp(ip, task) {
  return new Promise(resolve => {
    const start = () => {
      webuiActive.set(ip, (webuiActive.get(ip) || 0) + 1);
      Promise.resolve()
        .then(task)
        .catch(() => {})            // one failure never blocks the queue
        .then(() => {
          webuiActive.set(ip, Math.max(0, (webuiActive.get(ip) || 1) - 1));
          const waiting = webuiWaiting.get(ip);
          if (waiting && waiting.length) waiting.shift()();
          resolve();
        });
    };

    if ((webuiActive.get(ip) || 0) < WEBUI_CONCURRENCY) return start();
    if (!webuiWaiting.has(ip)) webuiWaiting.set(ip, []);
    webuiWaiting.get(ip).push(start);
  });
}

function handleWebuiProxyRequest(msg) {
  // Start the clock when the request ARRIVES, so time spent queued
  // counts against it. A request whose caller has already timed out is
  // dropped rather than served — the browser stopped waiting, and the
  // miner's limited capacity is better spent on requests still wanted.
  const expiresAt = Date.now() + (Number(msg.ttl_ms) || 30000);
  queueForIp(msg.ip, () => {
    if (Date.now() >= expiresAt) {
      console.log('[WEBUI] Skipping ' + (msg.path || '/') + ' — caller already gave up while it was queued');
      return Promise.resolve();
    }
    return handleWebuiProxyRequestNow(msg);
  });
}

// ── Digest challenge cache ──────────────────────────────────
// Antminer firmware answers with Digest auth. Every request used to
// start with a Basic attempt that the miner ALWAYS rejects with a 401,
// then repeat the request with Digest — two round trips for every
// single file on the page. Since requests to one miner are queued one
// at a time, that doubling is felt directly as the page loading at
// half speed, and on a dashboard pulling dozens of files it's the
// difference between a page that loads and one that looks stuck.
//
// The challenge (realm/nonce/qop) is reusable, so it's remembered per
// miner after the first 401 and every later request goes straight to
// Digest. A reused nonce must carry an incrementing count or a strict
// server rejects it, hence the counter.
const digestCache = new Map();

function ncHex(n) { return String(n).padStart(8, '0'); }

// One keep-alive connection per miner. These embedded web servers are
// slow to accept new TCP connections, and a fresh handshake for every
// file on the page is a large part of the wait. maxSockets:1 also
// enforces at the socket level the one-request-at-a-time rule the
// queue above maintains, so this can't accidentally flood the miner.
const minerHttpAgents = new Map();
function agentFor(ip) {
  let a = minerHttpAgents.get(ip);
  if (!a) {
    // Two sockets, not one: enough to overlap a slow response with the
    // next request without flooding a web server that only has a
    // handful of connection slots. Node queues anything beyond this
    // onto the existing sockets rather than opening more.
    a = new http.Agent({ keepAlive: true, keepAliveMsecs: 10000, maxSockets: 2, maxFreeSockets: 2 });
    minerHttpAgents.set(ip, a);
  }
  return a;
}

function handleWebuiProxyRequestNow(msg) {
  return new Promise(resolveQueue => {
  const { request_id, ip, method, path: reqPath, headers, body } = msg;
  const REQUEST_USER = 'root', REQUEST_PASS = 'root'; // every Antminer unit uses this

  // Extensions that are ALWAYS binary, whatever Content-Type the miner's
  // own web server claims. This exists because Braiins OS+'s embedded
  // server mislabels its font files (a generic text-ish type instead of
  // a real font/* one) — trusting that label made the isText check below
  // run buf.toString('utf8') on raw font bytes, which is a LOSSY,
  // irreversible conversion for arbitrary binary data (invalid byte
  // sequences get silently replaced, corrupting the file before it even
  // leaves this PC). No fix on the backend can undo that after the fact,
  // since the original bytes are already gone by the time it arrives —
  // this has to be caught here, at the only place that still has them.
  const ALWAYS_BINARY_EXT = /\.(woff2?|ttf|otf|eot|png|jpe?g|gif|ico|webp|bmp|mp4|webm|pdf|zip|gz)(\?|$)/i;

  function sendResponse(res, buf) {
    const contentType = res.headers['content-type'] || '';
    // Text content goes over the wire as plain UTF-8; anything else
    // (images, fonts, etc.) is base64-encoded so it survives JSON.
    // The extension check runs FIRST and wins over a misleading
    // Content-Type — see ALWAYS_BINARY_EXT above.
    const isText = !ALWAYS_BINARY_EXT.test(reqPath || '') && /text|json|javascript|xml|css/i.test(contentType);
    send({
      type: 'webui_proxy_response',
      request_id,
      status: res.statusCode,
      headers: { 'content-type': contentType || 'text/html', 'location': res.headers['location'] || null },
      body: isText ? buf.toString('utf8') : buf.toString('base64'),
      encoding: isText ? 'utf8' : 'base64',
    });
    resolveQueue();
  }

  function sendError(status, text) {
    send({ type: 'webui_proxy_response', request_id, status,
      headers: { 'content-type': 'text/plain' }, body: text, encoding: 'utf8' });
    resolveQueue();
  }

  // Some Antminer firmware wants Basic auth, some wants Digest — same
  // root/root credentials either way. Try Basic first (cheap, no extra
  // round-trip); if the miner replies 401 asking for Digest instead,
  // automatically retry with it. The person browsing never sees any of
  // this or has to type a password themselves.
  // phase 0 = first try (cached Digest if we have one, else Basic)
  // phase 1 = retry with a freshly issued challenge
  // phase 2 = last retry; a 401 after this is passed through to the browser
  function attempt(authHeader, phase, freshConnection) {
    const options = {
      hostname: ip, port: 80, path: reqPath || '/', method: method || 'GET',
      headers: { 'Authorization': authHeader },
      timeout: 8000,
      // A retry after a dropped connection deliberately does NOT reuse
      // the pooled socket. These miners' web servers handle keep-alive
      // inconsistently — a socket the pool believes is reusable can
      // already be dead at the miner's end, and every request handed to
      // it fails the same way. Retrying on a brand-new connection
      // sidesteps a stale pooled socket entirely.
      agent: freshConnection
        ? new http.Agent({ keepAlive: false, maxSockets: 1 })
        : agentFor(ip),
    };
    if (body) options.headers['Content-Length'] = Buffer.byteLength(body);
    if (headers && headers['content-type']) options.headers['Content-Type'] = headers['content-type'];

    const req = http.request(options, res => {
      if (res.statusCode === 401 && phase < 2 && res.headers['www-authenticate']) {
        const wa = res.headers['www-authenticate'];
        res.resume(); // drain this response, we're retrying
        if (wa.toLowerCase().startsWith('digest')) {
          // Remember the challenge so the next file on this page skips
          // straight to Digest instead of paying for a rejected Basic
          // attempt first. A 401 here on a CACHED nonce just means it
          // went stale, and this same path refreshes it.
          const params = parseDigestHeader(wa);
          digestCache.set(ip, { params, nc: 1 });
          const digestHeader = buildDigestAuth(REQUEST_USER, REQUEST_PASS, method || 'GET', reqPath || '/', params, ncHex(1));
          attempt(digestHeader, phase + 1);
          return;
        }
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => sendResponse(res, Buffer.concat(chunks)));
    });

    req.on('error', e => {
      // A miner whose web server is momentarily busy refuses or resets
      // the connection instead of queuing it. That is transient, but it
      // used to surface immediately as a 502 — which is what the
      // dashboard's own polling calls (stats.cgi, pools.cgi,
      // warning.cgi) were hitting, leaving panels stuck on stale
      // numbers or empty. One short retry clears it.
      const transient = /ECONNRESET|ECONNREFUSED|EPIPE|ECONNABORTED|socket hang up|EHOSTUNREACH|ETIMEDOUT/i.test(e.message || '');
      if (transient && connRetries < 2) {
        connRetries++;
        // Second attempt onwards goes over a fresh connection, and the
        // pool for this miner is discarded so no other queued request
        // inherits a socket that has already proven dead.
        if (connRetries === 1) minerHttpAgents.delete(ip);
        console.log(`[WEBUI] ${reqPath} → ${e.code || e.message} — retry ${connRetries}/2 on a fresh connection`);
        setTimeout(() => attempt(authHeader, phase, true), 300 * connRetries);
        return;
      }
      console.log(`[WEBUI] ✗ ${reqPath} → giving up: ${e.code || ''} ${e.message}`);
      sendError(502, 'Cannot reach miner (' + (e.code || 'error') + '): ' + e.message);
    });
    req.on('timeout', () => { req.destroy(); sendError(504, 'Miner did not respond in time'); });
    if (body) req.write(body);
    req.end();
  }
  let connRetries = 0;

  const cached = digestCache.get(ip);
  if (cached) {
    cached.nc += 1;
    attempt(buildDigestAuth(REQUEST_USER, REQUEST_PASS, method || 'GET', reqPath || '/', cached.params, ncHex(cached.nc)), 0);
  } else {
    attempt('Basic ' + Buffer.from(REQUEST_USER + ':' + REQUEST_PASS).toString('base64'), 0);
  }
  });
}

async function pollLanli() {
  if (!lanli) return;
  try {
    const readings = await lanli.readAllCabinets();
    if (readings) {
      console.log('[LANLI] Poll complete:', Object.keys(readings).length, 'cabinets');
      send({ type: 'lanli_data', readings, farm_id: FARM_ID, timestamp: new Date().toISOString() });
      await postJson(restUrl('/api/scada/rtu-data'), { farm_id: FARM_ID, readings }).catch(() => {});
    }
  } catch(e) {
    console.error('[LANLI] Poll error:', e.message);
  }
}

// ── Connect to server ──────────────────────────────────────
// Only ever one reconnect in flight. Two paths can ask for one (a close
// event and a forced terminate), and without this guard they each start
// their own chain — the agent then opens several sockets, the backend
// keeps only the newest, and the extra ones closing look exactly like
// disconnections.
function scheduleReconnect(why) {
  if (reconnectScheduled) return;
  reconnectScheduled = true;
  console.log(`[WARN] ${why} — retry in ${reconnectMs/1000}s`);
  setTimeout(() => { reconnectScheduled = false; connect(); }, reconnectMs);
  reconnectMs = Math.min(reconnectMs * 1.5, 30000);
}

function connect() {
  lastConnectAttemptAt = Date.now();
  const myGen = ++wsGeneration; // stale sockets must not drive reconnects
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║     EKALAVYA — FARM AGENT v1.0.0        ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  Farm   : ${FARM_NAME.padEnd(30)}║`);
  console.log(`║  ID     : ${FARM_ID.padEnd(30)}║`);
  console.log(`║  Subnet : ${SUBNETS.join(',').slice(0,30).padEnd(30)}║`);
  console.log('╚══════════════════════════════════════════╝\n');
  console.log(`[INFO] Connecting to ${SERVER}...`);

  ws = new WebSocket(SERVER, {
    headers: {
      'x-agent-key': AGENT_KEY, 'x-farm-id': FARM_ID,
      'x-farm-name': FARM_NAME, 'x-subnet': SUBNETS.join(','),
      'x-hostname': os.hostname(), 'x-agent-version': '1.0.0',
    }
  });

  let pongTimeout = null;
  let pingInterval = null;

  // ── Keepalive: detect a dead connection even when no close/error
  // event ever arrives (common after a server-side restart/redeploy) ──
  function heartbeatPing() {
    clearTimeout(pongTimeout);
    try { ws.ping(); } catch(e) {}
    // Same 32s overall tolerance as before, but checked far more often
    // — if Railway's own network layer enforces an idle-connection
    // timeout shorter than our old 25s/30s pacing, more frequent
    // traffic keeps the connection active often enough that it never
    // gets the chance to trigger, regardless of the exact cause.
    pongTimeout = setTimeout(() => {
      console.log('[WARN] No pong from server in 32s — forcing reconnect');
      try { ws.terminate(); } catch(e) {}
    }, 32000);
  }

  // A pong only proves the socket is alive at the network level, which
  // is not the same as the backend knowing about us — see the note on
  // lastServerMsgAt above. So it clears the pong timer and nothing more.
  ws.on('pong', () => { clearTimeout(pongTimeout); });

  let heartbeatMsgInterval = null, lanliInterval = null, ackCheckInterval = null;

  ws.on('open', () => {
    reconnectMs = 3000;
    lastServerMsgAt = Date.now(); // start the ack window fresh
    console.log(`[INFO] ✓ Connected | Farm: ${FARM_NAME}`);

    // The real health check: we send a heartbeat every 8s and the
    // backend acks every one of them while we're registered. If acks
    // stop arriving while the socket still reads as open, the backend
    // has lost track of this agent and only a fresh connection (which
    // re-sends the registration headers) will fix it.
    ackCheckInterval = setInterval(() => {
      if (!ws || ws.readyState !== 1) return;
      const silentFor = Date.now() - lastServerMsgAt;
      if (silentFor > 45000) {
        console.log(`[WARN] Socket is open but the server has not replied in ${Math.round(silentFor/1000)}s — it no longer knows this agent. Reconnecting to re-register.`);
        try { ws.terminate(); } catch(e) {}
      }
    }, 10000);
    pollTimer = setInterval(pollMiners, POLL_MS);
    heartbeatMsgInterval = setInterval(() => send({ type:'heartbeat', farm_id:FARM_ID }), 8000);
    // Ping every 8s; only reconnect if truly unresponsive for 32s
    pingInterval = setInterval(heartbeatPing, 8000);
    setTimeout(pollMiners, 5000);
    // Start Lanli RS485 polling if enabled
    if (LANLI_ENABLED && lanli) {
      lanliInterval = setInterval(pollLanli, 30000);
      setTimeout(pollLanli, 8000);
    }
  });

  ws.on('message', raw => {
    // Any message from the backend proves it's still talking to us at
    // the application layer — this is the signal the health check above
    // and the watchdog both rely on.
    lastServerMsgAt = Date.now();
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'welcome') {
        console.log(`[INFO] ${msg.message}`);
      } else if (msg.type === 'sensor_read_now') {
        console.log('[TH16] Manual read triggered');
        // Re-poll all known sensors immediately
        th16.startLivePolling(th16.getDiscovered().length > 0 ? th16.getDiscovered() : parseTHEnv(), 30000, onSensorReading);
      } else if (msg.type === 'webui_proxy_request') {
        handleWebuiProxyRequest(msg);
      } else if (msg.type === 'action_request') {
        handleActionRequest(msg);
      } else if (msg.type === 'sensor_discover') {
        const { ips, macs, session_id } = msg;
        send({ type:'sensor_discover_start', session_id, farm_id: FARM_ID });

        const doDiscover = async () => {
          let found = [];
          if (ips && ips.length > 0 && macs && macs.length > 0) {
            // Combined — scan the IP range and confirm the real sensor via MAC.
            // Best option when the sensor's MAC isn't in the ARP cache yet
            // (e.g. it's on a subnet the agent hasn't talked to before).
            console.log(`[TH16] Scanning ${ips.length} IPs, matching against MAC(s): ${macs.join(', ')}`);
            found = await th16.discoverByRangeAndMac(ips, macs, true);
          } else if (macs && macs.length > 0) {
            // MAC-only — relies on the ARP cache (fast, but only works if
            // the PC has already exchanged traffic with the device)
            console.log(`[TH16] Resolving MACs: ${macs.join(', ')}`);
            found = await th16.discoverByMAC(macs);
          } else if (ips && ips.length > 0) {
            // IP range scan only — no MAC to confirm against
            console.log(`[TH16] Scanning ${ips.length} IPs`);
            found = await th16.discoverInRange(ips, 20);
          }
          send({ type:'sensor_discover_done', session_id, farm_id: FARM_ID, found });
          found.filter(s=>s.temp!=null||s.humidity!=null).forEach(s => onSensorReading(s.ip, s));
        };
        doDiscover().catch(e => console.error('[TH16] Discovery error:', e.message));
      } else if (msg.type === 'hmi_capture') {
        console.log('[HMI] Screenshot requested');
        captureHmiScreenshot();
      } else if (msg.type === 'lanli_list_ports') {
        if (lanli) {
          lanli.listPorts().then(ports => send({ type:'lanli_ports', ports, farm_id:FARM_ID }));
        }
      } else if (msg.type === 'lanli_read_now') {
        console.log('[LANLI] Manual read triggered');
        pollLanli();
      } else if (msg.type === 'scan') {
        // Support multi-subnet: subnets[] array or single subnet string
        const subnetList = Array.isArray(msg.subnets) && msg.subnets.length > 0
          ? msg.subnets
          : (msg.subnet ? [msg.subnet] : SUBNETS);
        console.log(`[SCAN] ${subnetList.length} subnet(s): ${subnetList.join(', ')}`);
        scanMultipleSubnets(msg.session_id, subnetList, msg.ports, msg.timeout);
      } else if (msg.type === 'fetch_log') {
        console.log(`[LOG] Fetching from ${msg.ip}`);
        fetchMinerLog(msg.ip).then(log => {
          send({ type:'log_result', ip:msg.ip, request_id:msg.request_id, log: log||'Could not fetch log from miner.' });
        });
      } else if (msg.type === 'heartbeat_ack') {
        // silent
      } else {
        console.log(`[MSG] ${msg.type}`);
      }
    } catch(e) { console.error('[MSG] Error:', e.message); }
  });

  ws.on('close', code => {
    clearInterval(pingInterval);
    clearInterval(heartbeatMsgInterval);
    clearInterval(lanliInterval);
    clearInterval(ackCheckInterval);
    clearTimeout(pongTimeout);

    // A close from a socket that's already been replaced must not
    // schedule anything — the newer connection owns the reconnect path.
    // Its timers are its own; only clear the shared poll timer if this
    // is still the current connection.
    if (myGen !== wsGeneration) {
      console.log(`[INFO] Old connection closed (${code}) — a newer one is already active`);
      return;
    }
    clearInterval(pollTimer);

    // 4003: the backend already has an agent connected for this FARM_ID.
    // Reconnecting straight away just resumes the tug-of-war that made
    // both agents trade places every few seconds, so back off hard and
    // say plainly what needs fixing.
    if (code === 4003) {
      console.error('');
      console.error('  ════════════════════════════════════════════════════════');
      console.error('  DUPLICATE AGENT — another agent is already connected');
      console.error(`  using FARM_ID "${FARM_ID}".`);
      console.error('');
      console.error('  Two agents sharing one FARM_ID knock each other offline');
      console.error('  in a loop. Only one may run per farm.');
      console.error('');
      console.error('    • Check this PC for a second agent window, or for');
      console.error('      agent.js running alongside update-check.js');
      console.error('    • Or give the other machine its own FARM_ID in .env');
      console.error('');
      console.error('  Standing down for 5 minutes, then trying once more.');
      console.error('  ════════════════════════════════════════════════════════');
      console.error('');
      reconnectMs = 5 * 60 * 1000;
      scheduleReconnect('Duplicate FARM_ID');
      return;
    }

    scheduleReconnect(`Disconnected (${code})`);
  });

  ws.on('error', err => console.error(`[ERROR] ${err.message}`));
}

connect();
