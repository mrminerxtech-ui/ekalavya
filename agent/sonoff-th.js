// ============================================================
// SONOFF TH16 — Local LAN Reader
// Simple, safe — no UDP sockets, no blocking calls
// ============================================================
const http   = require('http');
const https  = require('https');
const net    = require('net');
const os     = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

// ── ARP lookup — MAC → IP ─────────────────────────────────
function normaliseMac(mac) {
  return mac.toLowerCase().replace(/[^a-f0-9]/g, '');
}

// Ping the broadcast address of every local /24 network this PC is on.
// This forces devices to reply and populates the OS ARP cache with
// entries that wouldn't otherwise be there yet (e.g. a sensor that was
// just moved onto the subnet and hasn't talked to this PC before).
function pingLocalBroadcasts() {
  return new Promise(resolve => {
    const ifaces = os.networkInterfaces();
    const targets = [];
    Object.values(ifaces).forEach(list => {
      (list || []).forEach(info => {
        if (info.family === 'IPv4' && !info.internal) {
          const parts = info.address.split('.');
          targets.push(parts.slice(0, 3).join('.') + '.255'); // assume /24
        }
      });
    });
    if (targets.length === 0) return resolve();

    let remaining = targets.length;
    const done = () => { remaining--; if (remaining <= 0) resolve(); };
    targets.forEach(bcast => {
      const args = process.platform === 'win32'
        ? ['-n', '1', '-w', '800', bcast]
        : ['-c', '1', '-W', '1', bcast];
      execFile('ping', args, { timeout: 1500 }, () => done());
    });
    // Safety net in case any ping callback never fires
    setTimeout(resolve, 2500);
  });
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
    const target = normaliseMac(mac);

    // 1. Check the existing ARP cache first — instant if already known
    let output = await runArp();
    let ip = parseArpOutput(output, target);
    if (ip) { console.log(`[TH16] MAC ${mac} → ${ip} (cached)`); return ip; }

    // 2. Not cached — ping local broadcasts to make devices announce themselves,
    //    then check the ARP cache again
    console.log(`[TH16] MAC ${mac} not in ARP cache — pinging local subnet(s)...`);
    await pingLocalBroadcasts();
    output = await runArp();
    ip = parseArpOutput(output, target);
    if (ip) { console.log(`[TH16] MAC ${mac} → ${ip} (after ping)`); return ip; }

    console.warn(`[TH16] MAC ${mac} not found — check it's powered on and on the same subnet as this PC`);
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
async function readTH16(ip, deviceId, apikey, debug) {
  // Try common LAN ports across firmware generations
  let r = await tryPort8081(ip, deviceId, apikey, debug, 8081, false);
  if (r) return r;
  r = await tryPort8081(ip, deviceId, apikey, debug, 8081, true); // same port, HTTPS
  if (r) return r;
  r = await tryPort8081(ip, deviceId, apikey, debug, 8082, false);
  if (r) return r;
  return await tryPort80(ip, debug);
}

async function tryPort8081(ip, deviceId, apikey, debug, port, useHttps) {
  port = port || 8081;
  try {
    const body = JSON.stringify({ deviceid: deviceId || '', sequence: Date.now().toString(), selfApikey: '4f2ecf19-f7a7-4076-869d-c6def6be3ab6', data: {} });
    const raw  = useHttps
      ? await httpsPost(ip, port, '/zeroconf/info', body, 2000, debug)
      : await httpPost(ip, port, '/zeroconf/info', body, 2000, debug);
    if (debug) console.log(`[TH16-DEBUG] ${ip}:${port}/zeroconf/info (${useHttps?'https':'http'}) raw →`, raw ? raw.slice(0, 400) : '(no response)');
    if (!raw) return null;
    const resp = JSON.parse(raw);
    if (debug) console.log(`[TH16-DEBUG] ${ip} parsed → error=${resp.error} encrypt=${resp.encrypt} data type=${typeof resp.data}`);
    if (resp.error !== 0 && resp.error !== undefined) return null;
    let data = resp.data;
    if (typeof data === 'string' && resp.iv && apikey) data = decryptData(data, resp.iv, apikey);
    if (typeof data === 'string' && resp.iv && !apikey) {
      if (debug) console.log(`[TH16-DEBUG] ${ip} → data is ENCRYPTED and no apikey supplied. Cannot decrypt.`);
      return null;
    }
    if (!data || typeof data !== 'object') return null;
    const temp     = parseFloat(data.currentTemperature ?? data.temperature ?? '') || null;
    const humidity = parseFloat(data.currentHumidity    ?? data.humidity    ?? '') || null;
    if (temp === null && humidity === null) return null;
    return { temp, humidity, switch: data.switch || 'unknown', firmware: 'new', model: 'THR316D' };
  } catch(e) {
    if (debug) console.log(`[TH16-DEBUG] ${ip} exception:`, e.message);
    return null;
  }
}

async function tryPort80(ip, debug) {
  try {
    const raw = await httpGet(ip, 80, '/', 2000);
    if (debug) console.log(`[TH16-DEBUG] ${ip}:80/ raw →`, raw ? raw.slice(0, 300) : '(no response)');
    if (!raw) return null;
    // Require BOTH currentTemperature AND currentHumidity in the SAME blob,
    // using the exact TH16 field names — not a generic 'temperature' or
    // 'humidity' match, which can false-positive on unrelated devices
    // (e.g. a miner's own chip-temperature status page).
    const m = raw.match(/\{[^}]*currentTemperature[^}]*currentHumidity[^}]*\}/i)
           || raw.match(/\{[^}]*currentHumidity[^}]*currentTemperature[^}]*\}/i);
    if (!m) { if (debug) console.log(`[TH16-DEBUG] ${ip}:80 → no TH16-style sensor JSON found (needs both currentTemperature and currentHumidity)`); return null; }
    const d    = JSON.parse(m[0]);
    let temp = parseFloat(d.currentTemperature ?? '');
    let hum  = parseFloat(d.currentHumidity ?? '');
    // Sanity check — reject implausible values (a genuine ambient
    // sensor won't read below -40°C, above 80°C, or humidity outside 0-100%)
    if (!isNaN(temp) && (temp < -40 || temp > 80)) temp = NaN;
    if (!isNaN(hum)  && (hum  < 0   || hum  > 100)) hum  = NaN;
    if (isNaN(temp) && isNaN(hum)) return null;
    return { temp: isNaN(temp) ? null : temp, humidity: isNaN(hum) ? null : hum, firmware: 'old' };
  } catch(e) { if (debug) console.log(`[TH16-DEBUG] ${ip}:80 exception:`, e.message); return null; }
}

function decryptData(enc, iv, apikey) {
  try {
    const key = crypto.createHash('md5').update(apikey).digest();
    const dc  = crypto.createDecipheriv('aes-128-cbc', key, Buffer.from(iv, 'base64'));
    return JSON.parse(Buffer.concat([dc.update(Buffer.from(enc,'base64')), dc.final()]).toString());
  } catch(e) { return null; }
}

// ── Discover by MAC ───────────────────────────────────────
async function scanCommonPorts(ip){
  const ports = [80, 443, 8080, 8081, 8082, 8443];
  const open = [];
  for (const p of ports) {
    if (await portOpen(ip, p, 800)) open.push(p);
  }
  return open;
}

async function discoverByMAC(macEntries) {
  const found = [];
  // Accept plain "MAC" or "MAC:deviceId" per entry so the device's
  // registered LAN ID can be supplied (required by newer firmware)
  const parsed = macEntries.map(function(e){
    const parts = e.split(':');
    // MAC itself contains colons (6 groups) — deviceId (if present) is
    // appended as a trailing 7th segment after the 6 MAC octets
    if (parts.length > 6) {
      return { mac: parts.slice(0, 6).join(':'), deviceId: parts.slice(6).join(':') };
    }
    return { mac: e, deviceId: '' };
  });

  const macs = parsed.map(function(p){ return p.mac; });
  const map  = await resolveMACsToIPs(macs);

  for (const entry of parsed) {
    const ip = map[entry.mac];
    if (!ip) { console.warn(`[TH16] Skipping ${entry.mac} — no IP resolved`); continue; }
    const openPorts = await scanCommonPorts(ip);
    console.log(`[TH16-DEBUG] ${ip} open ports: ${openPorts.length ? openPorts.join(', ') : 'NONE'}`);
    const r = await readTH16(ip, entry.deviceId, '', true);
    if (r) {
      console.log(`[TH16] ${entry.mac} @ ${ip} (id:${entry.deviceId||'none'}) → ${r.temp}°C, ${r.humidity}% (firmware: ${r.firmware})`);
      addSensor(ip, entry.deviceId, '', 'THR316D');
    } else {
      console.warn(`[TH16] ${entry.mac} @ ${ip} (id:${entry.deviceId||'none'}) → no readable response. Open ports: ${openPorts.join(',')||'none'}`);
    }
    found.push({ mac: entry.mac, ip, deviceId: entry.deviceId, ...(r || { temp: null, humidity: null }), type: 'sonoff-th' });
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

// ── Get the MAC address currently associated with an IP ────
// (reads the ARP cache — works after any TCP connection attempt to
// that IP, since that alone is enough to populate the ARP entry)
// Look up a MAC from an ALREADY-FETCHED arp table (no shelling out here —
// avoids spawning dozens of concurrent 'arp -a' processes, which was
// causing lookups to silently fail under load).
function findMacInArpOutput(output, ip) {
  for (const line of output.split('\n')) {
    if (!line.includes(ip)) continue;
    const macMatch = line.match(/([0-9a-fA-F]{2}[:\-]){5}[0-9a-fA-F]{2}/);
    if (macMatch) return macMatch[0].toUpperCase().replace(/-/g, ':');
  }
  return null;
}

async function getMacForIp(ip) {
  const output = await runArp();
  return findMacInArpOutput(output, ip);
}

// ── Combined search: scan an IP range, verify each live device's
// MAC address, and flag matches against a target MAC list. This finds
// a sensor even when its MAC was never in the ARP cache to begin with,
// as long as it's somewhere within the given IP range. ──────────────
async function discoverByRangeAndMac(ips, targetMacs, debug) {
  const targets = (targetMacs || []).map(m => normaliseMac(m));
  const found   = [];
  const concurrency = 12; // gentler — avoids contention with regular miner polling

  for (let i = 0; i < ips.length; i += concurrency) {
    const batch = ips.slice(i, i + concurrency);

    // Probe every IP in this batch first (just the TCP connect —
    // this alone is what populates each device's ARP entry)
    const aliveResults = await Promise.all(batch.map(async ip => {
      const open8081 = await portOpen(ip, 8081, 600);
      const open80   = !open8081 && await portOpen(ip, 80, 600);
      return (open8081 || open80) ? { ip, port: open8081 ? 8081 : 80 } : null;
    }));
    const alive = aliveResults.filter(Boolean);
    if (alive.length === 0) continue;

    // Small pause so the OS has definitely finished writing the new
    // ARP entries before we read the table
    await new Promise(r => setTimeout(r, 300));

    // Read the ARP table ONCE for this whole batch — not once per IP
    const arpOutput = await runArp();

    const results = await Promise.all(alive.map(async ({ ip, port }) => {
      const mac = findMacInArpOutput(arpOutput, ip);
      const macMatches = mac && targets.length > 0 && targets.includes(normaliseMac(mac));

      if (debug) console.log(`[TH16-DEBUG] ${ip} → alive (port ${port}), MAC: ${mac||'unknown'}${macMatches?' ← MATCH':''}`);

      if (targets.length > 0 && !macMatches) return { ip, mac, matched: false };

      const r = await readTH16(ip, '', '', debug);
      return { ip, mac, matched: macMatches || targets.length === 0, ...(r || {}) };
    }));
    results.forEach(r => { if (r) found.push(r); });
  }

  // Save any confirmed matches as active sensors for live polling
  found.filter(f => f.matched && (f.temp != null || f.humidity != null))
       .forEach(f => addSensor(f.ip, '', '', f.model || f.ip));

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
function httpPost(ip, port, path, body, timeout, debug) {
  return new Promise(resolve => {
    try {
      const req = http.request({
        hostname: ip, port, path, method: 'POST', timeout,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, res => {
        if (debug) console.log(`[TH16-DEBUG] ${ip}:${port}${path} → HTTP ${res.statusCode}`);
        let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(d));
      });
      req.on('error',   (e) => { if (debug) console.log(`[TH16-DEBUG] ${ip}:${port}${path} → connection error: ${e.code || e.message}`); resolve(null); });
      req.on('timeout', ()  => { if (debug) console.log(`[TH16-DEBUG] ${ip}:${port}${path} → timeout after ${timeout}ms (no response, connection stayed open)`); req.destroy(); resolve(null); });
      req.write(body); req.end();
    } catch(e) { if (debug) console.log(`[TH16-DEBUG] ${ip}:${port}${path} → exception: ${e.message}`); resolve(null); }
  });
}

function httpsPost(ip, port, path, body, timeout, debug) {
  return new Promise(resolve => {
    try {
      const req = https.request({
        hostname: ip, port, path, method: 'POST', timeout,
        rejectUnauthorized: false, // local device — self-signed cert is expected
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, res => {
        if (debug) console.log(`[TH16-DEBUG] ${ip}:${port}${path} (https) → HTTP ${res.statusCode}`);
        let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(d));
      });
      req.on('error',   (e) => { if (debug) console.log(`[TH16-DEBUG] ${ip}:${port}${path} (https) → connection error: ${e.code || e.message}`); resolve(null); });
      req.on('timeout', ()  => { if (debug) console.log(`[TH16-DEBUG] ${ip}:${port}${path} (https) → timeout after ${timeout}ms`); req.destroy(); resolve(null); });
      req.write(body); req.end();
    } catch(e) { if (debug) console.log(`[TH16-DEBUG] ${ip}:${port}${path} (https) → exception: ${e.message}`); resolve(null); }
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

module.exports = { readTH16, discoverByMAC, discoverInRange, discoverByRangeAndMac, resolveMAC, startLivePolling, addSensor, getReadings, getDiscovered };
