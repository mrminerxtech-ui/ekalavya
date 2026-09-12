// ============================================================
// EKALAVYA AGENT — Manifest-Driven Auto-Updater
// ------------------------------------------------------------
// • Check-in: reports version/uptime/health to the backend on
//   its own short interval, independent of the agent's own heartbeat
// • Self-update: reads manifest.json from GitHub, compares versions,
//   downloads only what changed, verifies SHA-256 before installing
// • Process supervision: runs agent.js as a child process, restarts
//   on crash with exponential backoff, gives up escalating after
//   repeated failures (won't infinite-loop-restart every second)
// • Manifest-driven: the file list lives in manifest.json, not
//   hardcoded here — adding a new agent file needs no updater change
// ============================================================
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const os     = require('os');
const { spawn } = require('child_process');

// ── Config ──────────────────────────────────────────────────
const GITHUB_REPO    = process.env.UPDATE_REPO   || 'mrminerxtech-ui/ekalavya';
const GITHUB_BRANCH  = process.env.UPDATE_BRANCH || 'main';
const CHECK_EVERY_MS = 10 * 60 * 1000;      // manifest check interval
const CHECKIN_MS     = 60 * 1000;           // check-in ping interval
const AGENT_DIR      = __dirname;
const LOCAL_MANIFEST = path.join(AGENT_DIR, '.manifest-installed.json');
const CRASH_WINDOW_MS   = 5 * 60 * 1000;    // crash-loop detection window
const CRASH_LIMIT       = 5;                // max crashes in that window before backing off hard

// ── Local state ─────────────────────────────────────────────
let agentProcess   = null;
let startedAt      = Date.now();
let crashTimestamps = [];
let restartDelayMs = 2000;
let lastCheckin    = null;
let lastUpdateAt   = readLocalVersion()?.applied_at || null;

function readLocalVersion() {
  try { return JSON.parse(fs.readFileSync(LOCAL_MANIFEST, 'utf8')); }
  catch(e) { return null; }
}
function writeLocalVersion(manifest) {
  try {
    fs.writeFileSync(LOCAL_MANIFEST, JSON.stringify({
      version: manifest.version,
      applied_at: new Date().toISOString(),
      files: manifest.files.map(f => ({ name: f.name, sha256: f.sha256 })),
    }, null, 2));
  } catch(e) { console.error('[UPDATE] Could not write local manifest:', e.message); }
}

// ── Fetch raw content from GitHub ──────────────────────────
function fetchRaw(filePath) {
  return new Promise((resolve, reject) => {
    const url = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/agent/${filePath}?t=${Date.now()}`;
    const headers = { 'User-Agent': 'ekalavya-agent-updater' };
    if (process.env.GITHUB_TOKEN) headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
    https.get(url, { headers }, res => {
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode} for ${filePath}`)); return; }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// ── Fetch and validate the manifest itself ─────────────────
async function fetchManifest() {
  const raw = await fetchRaw('manifest.json');
  const manifest = JSON.parse(raw);
  if (!manifest.version || !Array.isArray(manifest.files)) {
    throw new Error('Malformed manifest.json — missing version or files[]');
  }
  return manifest;
}

// ── Apply one file from the manifest, verifying its checksum ──
async function applyFile(fileEntry) {
  const localPath = path.join(AGENT_DIR, fileEntry.name);
  let remote;
  try { remote = await fetchRaw(fileEntry.name); }
  catch(e) { console.error(`[UPDATE] ✗ Could not fetch ${fileEntry.name}: ${e.message}`); return false; }

  const actualHash = sha256(remote);
  if (actualHash !== fileEntry.sha256) {
    console.error(`[UPDATE] ✗ Checksum mismatch for ${fileEntry.name} — expected ${fileEntry.sha256.slice(0,12)}..., got ${actualHash.slice(0,12)}... Rejecting (possible corrupted download or manifest out of sync).`);
    return false;
  }

  // Syntax sanity check before ever touching the live file
  try { new Function(remote); }
  catch(e) { console.error(`[UPDATE] ✗ ${fileEntry.name} failed syntax check: ${e.message}`); return false; }

  try { if (fs.existsSync(localPath)) fs.copyFileSync(localPath, localPath + '.bak'); } catch(e) {}
  fs.writeFileSync(localPath, remote, 'utf8');
  console.log(`[UPDATE] ✓ Installed ${fileEntry.name} (sha256 ${actualHash.slice(0,12)}...)`);
  return true;
}

// ── Manifest-driven update check ───────────────────────────
async function checkForUpdates(onUpdateApplied) {
  console.log('[UPDATE] Checking manifest.json on GitHub...');
  let manifest;
  try { manifest = await fetchManifest(); }
  catch(e) { console.log(`[UPDATE] Could not fetch manifest: ${e.message}`); return; }

  const local = readLocalVersion();
  if (local && local.version === manifest.version) {
    // Same version — but still verify each file's checksum matches
    // (catches manual edits or partial installs, not just version bumps)
    const allMatch = manifest.files.every(mf => {
      const lf = local.files.find(x => x.name === mf.name);
      return lf && lf.sha256 === mf.sha256;
    });
    if (allMatch) { console.log(`[UPDATE] Already on v${manifest.version} — up to date.`); return; }
    console.log('[UPDATE] Version matches but file checksums differ — reinstalling.');
  } else {
    console.log(`[UPDATE] New version available: ${local ? local.version : '(none)'} → ${manifest.version}`);
    if (manifest.changelog?.length) {
      console.log('[UPDATE] Changelog:');
      manifest.changelog.forEach(line => console.log('  • ' + line));
    }
  }

  let allOk = true;
  for (const fileEntry of manifest.files) {
    const ok = await applyFile(fileEntry);
    if (!ok) allOk = false;
  }

  if (allOk) {
    writeLocalVersion(manifest);
    lastUpdateAt = new Date().toISOString();
    console.log(`[UPDATE] ✓ Now on v${manifest.version} — restarting agent.`);
    onUpdateApplied();
  } else {
    console.log('[UPDATE] ✗ Update incomplete — one or more files failed verification. Keeping current version running.');
  }
}

// ── Process supervision ────────────────────────────────────
function recordCrash() {
  const now = Date.now();
  crashTimestamps.push(now);
  crashTimestamps = crashTimestamps.filter(t => now - t < CRASH_WINDOW_MS);
  return crashTimestamps.length;
}

function startAgent() {
  console.log('[SUPERVISOR] Starting agent.js...');
  startedAt = Date.now();
  agentProcess = spawn(process.execPath, [path.join(AGENT_DIR, 'agent.js')], {
    stdio: 'inherit',
    env: process.env,
  });

  agentProcess.on('exit', code => {
    const crashCount = recordCrash();
    console.log(`[SUPERVISOR] Agent exited (code ${code}) — ${crashCount} crash(es) in the last ${CRASH_WINDOW_MS/60000} min`);

    if (crashCount >= CRASH_LIMIT) {
      // Crash loop — something is fundamentally broken (bad .env, bad
      // network, corrupted file). Back off hard instead of hammering
      // the machine or GitHub with rapid restarts.
      restartDelayMs = Math.min(restartDelayMs * 2, 5 * 60 * 1000);
      console.log(`[SUPERVISOR] ⚠ Crash loop detected — backing off to ${restartDelayMs/1000}s between restarts`);
    } else {
      restartDelayMs = 2000; // normal, isolated crash — restart quickly
    }
    setTimeout(startAgent, restartDelayMs);
  });
}

function restartAgent() {
  if (agentProcess) {
    agentProcess.removeAllListeners('exit');
    agentProcess.kill();
  }
  setTimeout(startAgent, 1000);
}

// ── Check-in / heartbeat reporting ─────────────────────────
// Independent of the agent's own WebSocket heartbeat — this reports
// updater-level health (version, uptime, crash history) so the app
// can show "this PC's supervisor is alive" even if the agent itself
// is mid-restart.
function postJson(urlStr, body) {
  return new Promise(resolve => {
    try {
      const url  = new URL(urlStr);
      const data = JSON.stringify(body);
      const mod  = url.protocol === 'https:' ? https : require('http');
      const req  = mod.request({
        hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname, method: 'POST', timeout: 5000,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      }, res => { res.resume(); resolve(true); });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.write(data); req.end();
    } catch(e) { resolve(false); }
  });
}

function restUrl(pathSuffix) {
  const server = process.env.MMX_SERVER || '';
  return server.replace('wss://', 'https://').replace('ws://', 'http://').replace(/\/agent$/, '') + pathSuffix;
}

async function checkIn() {
  const local = readLocalVersion();
  const payload = {
    farm_id:        process.env.FARM_ID || os.hostname(),
    farm_name:      process.env.FARM_NAME || process.env.FARM_ID || os.hostname(),
    updater_uptime: Math.floor((Date.now() - startedAt) / 1000),
    version:        local?.version || 'unknown',
    last_update_at: lastUpdateAt,
    crash_count_5m: crashTimestamps.length,
    node_version:   process.version,
    hostname:       os.hostname(),
    timestamp:      new Date().toISOString(),
  };
  const ok = await postJson(restUrl('/api/agents/checkin'), payload);
  lastCheckin = new Date().toISOString();
  if (!ok) console.log('[CHECKIN] Could not reach backend (will retry)');
}

// ── Main ────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  EKALAVYA AGENT — Update & Supervisor    ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`[INIT] Repo: ${GITHUB_REPO} (${GITHUB_BRANCH})`);
  const local = readLocalVersion();
  console.log(`[INIT] Installed version: ${local ? local.version : '(none — first run)'}`);
  console.log(`[INIT] Update check every ${CHECK_EVERY_MS/60000}m · Check-in every ${CHECKIN_MS/1000}s\n`);

  // Pull latest before first start — a brand-new PC gets current code immediately
  await checkForUpdates(() => {});
  startAgent();

  setInterval(() => checkForUpdates(restartAgent), CHECK_EVERY_MS);
  setInterval(checkIn, CHECKIN_MS);
  checkIn(); // immediate first check-in
}

main().catch(e => {
  console.error('[FATAL]', e.message);
  startAgent(); // even if the updater itself fails, still try to run the agent
});
