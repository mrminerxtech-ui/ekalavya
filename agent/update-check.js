// ============================================================
// EKALAVYA AGENT — Auto-Updater
// Checks GitHub for a newer agent version, downloads it, and
// restarts automatically. Runs as a small separate process so
// the updater itself never needs to update.
// ============================================================
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { spawn } = require('child_process');

// ── Config ──────────────────────────────────────────────────
const GITHUB_REPO   = process.env.UPDATE_REPO   || 'mrminerxtech-ui/ekalavya';
const GITHUB_BRANCH = process.env.UPDATE_BRANCH || 'main';
const CHECK_EVERY_MS = 10 * 60 * 1000; // check every 10 minutes
const AGENT_DIR = __dirname;

// Files that get auto-updated. Add new agent files here if you create more.
const MANAGED_FILES = [
  'agent.js',
  'sonoff-th.js',
  'lanli-rs485.js',
];

// ── Fetch raw file content from GitHub ────────────────────
function fetchRaw(filePath) {
  return new Promise((resolve, reject) => {
    const url = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/agent/${filePath}?t=${Date.now()}`;
    const headers = { 'User-Agent': 'ekalavya-agent-updater' };
    // Only needed if the repo is private — leave GITHUB_TOKEN unset for public repos
    if (process.env.GITHUB_TOKEN) headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
    https.get(url, { headers }, res => {
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode} for ${filePath}`)); return; }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// ── Compare and update one file ───────────────────────────
async function checkFile(filename) {
  const localPath = path.join(AGENT_DIR, filename);
  let remote;
  try {
    remote = await fetchRaw(filename);
  } catch(e) {
    console.log(`[UPDATE] Could not check ${filename}: ${e.message}`);
    return false;
  }
  if (!remote || remote.length < 50) return false; // sanity check — avoid saving garbage/empty

  let local = '';
  try { local = fs.readFileSync(localPath, 'utf8'); } catch(e) { /* file doesn't exist yet */ }

  if (remote === local) return false; // already up to date

  // Basic syntax sanity check before overwriting — never install a broken file
  try {
    new Function(remote); // throws on syntax errors
  } catch(e) {
    console.log(`[UPDATE] ✗ Rejected ${filename} — syntax error in downloaded version: ${e.message}`);
    return false;
  }

  // Back up the current version before replacing it
  try {
    if (local) fs.writeFileSync(localPath + '.bak', local, 'utf8');
  } catch(e) {}

  fs.writeFileSync(localPath, remote, 'utf8');
  console.log(`[UPDATE] ✓ Updated ${filename}`);
  return true;
}

// ── Check all managed files, restart agent if anything changed ──
async function checkForUpdates(onUpdateFound) {
  console.log('[UPDATE] Checking GitHub for agent updates...');
  let anyUpdated = false;
  for (const file of MANAGED_FILES) {
    const updated = await checkFile(file);
    if (updated) anyUpdated = true;
  }
  if (anyUpdated) {
    console.log('[UPDATE] Files updated — restarting agent...');
    onUpdateFound();
  } else {
    console.log('[UPDATE] Already up to date.');
  }
}

// ── Launch the actual agent as a child process ────────────
let agentProcess = null;
function startAgent() {
  console.log('[UPDATE] Starting agent.js...');
  agentProcess = spawn(process.execPath, [path.join(AGENT_DIR, 'agent.js')], {
    stdio: 'inherit',
    env: process.env,
  });
  agentProcess.on('exit', code => {
    console.log(`[UPDATE] Agent exited (code ${code}) — restarting in 5s...`);
    setTimeout(startAgent, 5000);
  });
}

function restartAgent() {
  if (agentProcess) {
    agentProcess.removeAllListeners('exit');
    agentProcess.kill();
  }
  setTimeout(startAgent, 1000);
}

// ── Main ───────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   EKALAVYA AGENT — Auto-Update Launcher  ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`[UPDATE] Repo: ${GITHUB_REPO} (${GITHUB_BRANCH})`);
  console.log(`[UPDATE] Checking every ${CHECK_EVERY_MS/60000} minutes\n`);

  // Check once before first start, so a brand-new PC pulls the latest code immediately
  await checkForUpdates(() => {});
  startAgent();

  // Periodic checks while running
  setInterval(() => checkForUpdates(restartAgent), CHECK_EVERY_MS);
}

main().catch(e => {
  console.error('[UPDATE] Fatal error:', e.message);
  // Even if the updater itself fails, still try to start the agent
  startAgent();
});
