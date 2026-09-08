require('dotenv').config();
const WebSocket = require('ws');
const net       = require('net');
const http      = require('http');
const https     = require('https');
const os        = require('os');

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

let ws = null, reconnectMs = 3000, pollTimer = null;

// ── HTTP helper ────────────────────────────────────────────
function httpGet(ip, path, auth) {
  return new Promise(resolve => {
    const headers = auth ? { 'Authorization': 'Basic ' + Buffer.from(auth).toString('base64') } : {};
    const req = http.request({ hostname:ip, port:80, path, method:'GET', headers, timeout:4000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d||null); } });
    });
    req.on('error',   () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
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
  // Scrypt — any L-series Antminer: L3, L3+, L5, L7, L9, L9 Hydro, L11 etc
  if (/l\d/.test(m) || m.includes('scrypt') || m.includes('litecoin') || m.includes(' ltc')) return 'Scrypt';
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

// ── Full miner info ────────────────────────────────────────
async function getMinerInfo(ip) {
  // Parallel API calls via CGMiner TCP
  const [summary, stats, devs, pools] = await Promise.all([
    cgCmd(ip, 'summary'),
    cgCmd(ip, 'stats'),
    cgCmd(ip, 'devs'),
    cgCmd(ip, 'pools'),
  ]);

  let model = extractModel(stats, summary);
  
  // Fallback: try Antminer HTTP for model
  if (!model) {
    const typeData = await httpGet(ip, '/cgi-bin/type.cgi', 'root:root');
    if (typeof typeData === 'string') model = typeData.trim();
    else if (typeData?.type) model = typeData.type;
    
    // Avalon HTTP fallback
    if (!model) {
      const avaInfo = await httpGet(ip, '/api/v1/info', 'root:root');
      if (avaInfo?.system_hw_version) model = 'AvalonMiner ' + avaInfo.system_hw_version;
    }
  }

  if (!model || model.length < 3) model = 'ASIC Miner';
  
  const algo  = getAlgo(model);
  const brand = getBrand(model);

  // Hashrate from summary
  const s      = summary?.SUMMARY?.[0] || {};
  const rawMhs = parseFloat(s['MHS 5s'] || s['MHS av'] || (s['GHS 5s']||0)*1000 || (s['THS 5s']||0)*1e6 || 0);
  const hr     = convertHashrate(rawMhs, algo);

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

  // Pool info — check all configured pools, prefer the active one
  const allPools = pools?.POOLS || [];
  const activePool = allPools.find(p => p.Stratum === true || p['Stratum Active'] === true)
                   || allPools.find(p => p.Status === 'Alive')
                   || allPools[0] || {};
  const power = parseInt(st0.power || st0.Power || s.Power || 0);
  const uptime = formatUptime(parseInt(s.Elapsed||0));

  // Full worker ID as configured on the miner — includes wallet/worker suffix
  const fullWorkerId = activePool.User || allPools.map(p => p.User).find(u => u && u !== '') || '—';

  // HW errors and shares
  const accepted  = parseInt(s.Accepted||0);
  const rejected  = parseInt(s.Rejected||0);
  const hwErrors  = parseInt(s['Hardware Errors']||0);
  const boards    = (devs?.DEVS||[]).length;

  return {
    ip, model, brand, algo,
    hashrate:    hr.value,
    hr_unit:     hr.unit,
    hr_display:  hr.display,
    temp, fan, power, uptime,
    pool:        activePool.URL     || '—',
    worker:      fullWorkerId,
    worker_id:   fullWorkerId,   // full string exactly as configured on the miner
    pool_status: activePool.Status  || '—',
    pools:       allPools.map(p => ({ url: p.URL, user: p.User, status: p.Status, priority: p.Priority })),
    accepted, rejected, hw_errors: hwErrors,
    boards,
    status: 'online',
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
async function fetchMinerLog(ip) {
  // Try Antminer log endpoint
  const log1 = await httpGet(ip, '/cgi-bin/get_system_info.cgi', 'root:root');
  if (log1) return JSON.stringify(log1, null, 2);
  
  // Try CGMiner check command (limited log)
  const check = await cgCmd(ip, 'check');
  if (check) return JSON.stringify(check, null, 2);

  // Try standard syslog
  const log2 = await httpGet(ip, '/cgi-bin/log.cgi', 'root:root');
  if (log2) return typeof log2 === 'string' ? log2 : JSON.stringify(log2, null, 2);

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
async function pollMiners() {
  const ips = subnetToIPs(SUBNET);
  const live = [];
  const BATCH = 25;
  for (let i = 0; i < ips.length; i += BATCH) {
    const batch = ips.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async ip => {
      if (!await checkPort(ip, CGPORT, 1500)) return null;
      return getMinerInfo(ip).catch(() => null);
    }));
    live.push(...results.filter(Boolean));
  }
  if (live.length > 0) {
    console.log(`[POLL] ${live.length} miners online`);
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
function connect() {
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

  ws.on('open', () => {
    reconnectMs = 3000;
    console.log(`[INFO] ✓ Connected | Farm: ${FARM_NAME}`);
    pollTimer = setInterval(pollMiners, POLL_MS);
    setInterval(() => send({ type:'heartbeat', farm_id:FARM_ID }), 20000);
    setTimeout(pollMiners, 5000);
    // Start Lanli RS485 polling if enabled
    if (LANLI_ENABLED && lanli) {
      setInterval(pollLanli, 30000);
      setTimeout(pollLanli, 8000);
    }
  });

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'welcome') {
        console.log(`[INFO] ${msg.message}`);
      } else if (msg.type === 'sensor_read_now') {
        console.log('[TH16] Manual read triggered');
        // Re-poll all known sensors immediately
        th16.startLivePolling(th16.getDiscovered().length > 0 ? th16.getDiscovered() : parseTHEnv(), 30000, onSensorReading);
      } else if (msg.type === 'sensor_discover') {
        const { ips, macs, session_id } = msg;
        send({ type:'sensor_discover_start', session_id, farm_id: FARM_ID });

        const doDiscover = async () => {
          let found = [];
          if (macs && macs.length > 0) {
            // MAC-based discovery — most accurate
            console.log(`[TH16] Resolving MACs: ${macs.join(', ')}`);
            found = await th16.discoverByMAC(macs);
          } else if (ips && ips.length > 0) {
            // IP range scan
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
    clearInterval(pollTimer);
    console.log(`[WARN] Disconnected (${code}) — retry in ${reconnectMs/1000}s`);
    setTimeout(connect, reconnectMs);
    reconnectMs = Math.min(reconnectMs * 1.5, 30000);
  });

  ws.on('error', err => console.error(`[ERROR] ${err.message}`));
}

connect();
