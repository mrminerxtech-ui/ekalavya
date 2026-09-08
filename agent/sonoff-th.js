// ============================================================
// SONOFF TH16 — Local LAN Reader
// Simple, safe — no UDP sockets, no blocking calls
// ============================================================
const http   = require('http');
const net    = require('net');
const crypto = require('crypto');
const { execFile } = require('child_process');

// ── ARP lookup — MAC → IP ─────────────────────────────────
function normaliseMac(mac) {
  return mac.toLowerCase().replace(/[^a-f0-9]/g, '');
}

function runArp() {
  return new Promise(resolve => {
    // Timeout after 3 seconds so it never hangs
    const timer = setTimeout(() => resolve(''), 3000);
    execFile('arp', ['-a'], { timeout: 3000 }, (err, stdout) => {
      clearTimeout(timer);
      resolve(err ? '' : stdout);
    });
  });
}

function parseArpOutput(output, targetMac) {
  for (const line of output.split('\n')) {
    const macMatch = line.match(/([0-9a-fA-F]{2}[:\-]){5}[0-9a-fA-F]{2}/);
    if (!macMatch) continue;
    if (normaliseMac(macMatch[0]) === targetMac) {
      const ipMatch = line.match(/(\d{1,3}\.){3}\d{1,3}/);
      if (ipMatch) return ipMatch[0];
    }
  }
  return null;
}

async function resolveMAC(mac) {
  try {
    const target  = normaliseMac(mac);
    const output  = await runArp();
    const ip      = parseArpOutput(output, target);
    if (ip) { console.log(`[TH16] MAC ${mac} → ${ip}`); return ip; }
    console.warn(`[TH16] MAC ${mac} not found in ARP table`);
    return null;
  } catch(e) {
    console.error('[TH16] ARP error:', e.message);
    return null;
  }
}

async function resolveMACsToIPs(macs) {
  const results = {};
  for (const mac of macs) {
    results[mac] = await resolveMAC(mac);
  }
  return results;
}

// ── Read TH16 via HTTP ────────────────────────────────────
async function readTH16(ip, deviceId, apikey) {
  // Try port 8081 (new firmware) then port 80 (old firmware)
  let r = await tryPort8081(ip, deviceId, apikey);
  if (r) return r;
  return await tryPort80(ip);
}

async function tryPort8081(ip, deviceId, apikey) {
  try {
    const body = JSON.stringify({ deviceid: deviceId || '', sequence: Date.now().toString(), selfApikey: '123', data: {} });
    const raw  = await httpPost(ip, 8081, '/zeroconf/info', body, 2000);
    if (!raw) return null;
    const resp = JSON.parse(raw);
    if (resp.error !== 0 && resp.error !== undefined) return null;
    let data = resp.data;
    if (typeof data === 'string' && resp.iv && apikey) data = decryptData(data, resp.iv, apikey);
    if (!data || typeof data !== 'object') return null;
    const temp     = parseFloat(data.currentTemperature ?? data.temperature ?? '') || null;
    const humidity = parseFloat(data.currentHumidity    ?? data.humidity    ?? '') || null;
    if (temp === null && humidity === null) return null;
    return { temp, humidity, switch: data.switch || 'unknown', firmware: 'new' };
  } catch(e) { return null; }
}

async function tryPort80(ip) {
  try {
    const raw = await httpGet(ip, 80, '/', 2000);
    if (!raw) return null;
    const m = raw.match(/\{[^}]*(?:temperature|humidity)[^}]*\}/i);
    if (!m) return null;
    const d    = JSON.parse(m[0]);
    const temp = parseFloat(d.currentTemperature ?? d.temperature ?? '') || null;
    const hum  = parseFloat(d.currentHumidity    ?? d.humidity    ?? '') || null;
    if (temp === null && hum === null) return null;
    return { temp, humidity: hum, firmware: 'old' };
  } catch(e) { return null; }
}

function decryptData(enc, iv, apikey) {
  try {
    const key = crypto.createHash('md5').update(apikey).digest();
    const dc  = crypto.createDecipheriv('aes-128-cbc', key, Buffer.from(iv, 'base64'));
    return JSON.parse(Buffer.concat([dc.update(Buffer.from(enc,'base64')), dc.final()]).toString());
  } catch(e) { return null; }
}

// ── Discover by MAC ───────────────────────────────────────
async function discoverByMAC(macs) {
  const found = [];
  const map   = await resolveMACsToIPs(macs);
  for (const [mac, ip] of Object.entries(map)) {
    if (!ip) continue;
    const r = await readTH16(ip, '', '');
    found.push({ mac, ip, ...(r || { temp: null, humidity: null }), type: 'sonoff-th' });
    if (r) addSensor(ip, '', '', ip);
  }
  return found;
}

// ── Discover by IP range ──────────────────────────────────
async function discoverInRange(ips, concurrency = 20) {
  const found = [];
  for (let i = 0; i < ips.length; i += concurrency) {
    const batch   = ips.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(async ip => {
      const open = await portOpen(ip, 8081, 800) || await portOpen(ip, 80, 800);
      if (!open) return null;
      const r = await readTH16(ip, '', '');
      return r ? { ip, ...r, type: 'sonoff-th' } : null;
    }));
    results.forEach(r => { if (r) { found.push(r); addSensor(r.ip, '', '', r.ip); } });
  }
  return found;
}

function portOpen(ip, port, timeout) {
  return new Promise(resolve => {
    const s = new net.Socket();
    s.setTimeout(timeout);
    s.connect(port, ip, () => { s.destroy(); resolve(true); });
    s.on('error',   () => { s.destroy(); resolve(false); });
    s.on('timeout', () => { s.destroy(); resolve(false); });
  });
}

// ── Live polling ──────────────────────────────────────────
const sensors  = new Map(); // ip → config
const readings = new Map(); // ip → latest reading
let   callback = null;
let   pollInt  = null;

function addSensor(ip, deviceId, apikey, name) {
  sensors.set(ip, { ip, deviceId: deviceId||'', apikey: apikey||'', name: name||ip });
}

async function doPoll() {
  for (const [ip, cfg] of sensors.entries()) {
    const r = await readTH16(ip, cfg.deviceId, cfg.apikey);
    if (r) {
      readings.set(ip, { ...r, ip, name: cfg.name, updated: new Date().toISOString() });
      if (callback) callback(ip, readings.get(ip));
    }
  }
}

function startLivePolling(initialSensors, intervalMs, onReading) {
  if (initialSensors?.length) initialSensors.forEach(s => addSensor(s.ip, s.deviceId, s.apikey, s.name));
  callback = onReading;
  if (pollInt) clearInterval(pollInt);
  if (sensors.size === 0) return;
  doPoll(); // immediate
  pollInt = setInterval(doPoll, intervalMs || 30000);
  console.log(`[TH16] Polling ${sensors.size} sensor(s) every ${(intervalMs||30000)/1000}s`);
}

// ── HTTP helpers ──────────────────────────────────────────
function httpPost(ip, port, path, body, timeout) {
  return new Promise(resolve => {
    try {
      const req = http.request({
        hostname: ip, port, path, method: 'POST', timeout,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(d)); });
      req.on('error',   () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.write(body); req.end();
    } catch(e) { resolve(null); }
  });
}

function httpGet(ip, port, path, timeout) {
  return new Promise(resolve => {
    try {
      const req = http.request({ hostname: ip, port, path, method: 'GET', timeout }, res => {
        let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(d));
      });
      req.on('error',   () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    } catch(e) { resolve(null); }
  });
}

function getReadings()   { return Array.from(readings.values()); }
function getDiscovered() { return Array.from(sensors.values()); }

module.exports = { readTH16, discoverByMAC, discoverInRange, resolveMAC, startLivePolling, addSensor, getReadings, getDiscovered };
