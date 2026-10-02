// ============================================================
// AGENT PACKAGE — the agent folder as one .zip, from the app
// ------------------------------------------------------------
// Remote Access › Add a farm PC › Download agent. The files are taken
// from the same place the agents update themselves from (the `agent/`
// folder of the GitHub repo), so the download is always the current
// version — nothing to keep in step by hand. Zipped here (no extra
// package: a .zip is simple enough to write directly) and kept for a few
// minutes so repeated downloads don't hit GitHub again.
//
// Never included: `.env`, `.farm.json`, logs — a download is a clean
// agent that waits for its farm in Remote Access › New agents.
// ============================================================
const axios = require('axios');
const zlib  = require('zlib');

const REPO   = process.env.UPDATE_REPO   || 'mrminerxtech-ui/ekalavya';
const BRANCH = process.env.UPDATE_BRANCH || 'main';
const FOLDER = 'ekalavya-agent';
const CACHE_MS = 5 * 60 * 1000;
// Needed for a working agent; the download is refused without them.
const REQUIRED = ['agent.js', 'agent-guard.js', 'update-check.js', 'SETUP-WINDOWS.bat'];
// Everything else that may be in the folder (missing ones are skipped).
const OPTIONAL = ['package.json', 'sonoff-th.js', 'lanli-rs485.js', 'START.bat', 'manifest.json', 'package-lock.json', 'README.md', 'README.txt', 'SETUP-LINUX.sh', 'setup.sh', 'start.sh'];
const SKIP = /^(\.env.*|\.farm\.json|\.manifest-installed\.json|.*\.log|node_modules)$/i;

const raw = name => `https://raw.githubusercontent.com/${REPO}/${BRANCH}/agent/${encodeURIComponent(name)}?t=${Date.now()}`;
async function fetchFile(name) {
  try {
    const r = await axios.get(raw(name), { responseType: 'arraybuffer', timeout: 20000, validateStatus: s => s === 200 || s === 404 });
    return r.status === 200 ? Buffer.from(r.data) : null;
  } catch (e) { return null; }
}
// File names in the folder: GitHub's listing when it answers (it is rate
// limited for anonymous callers), else the names we know + the manifest's.
async function listNames() {
  const names = new Set([...REQUIRED, ...OPTIONAL]);
  try {
    const r = await axios.get(`https://api.github.com/repos/${REPO}/contents/agent?ref=${BRANCH}`, { timeout: 10000, headers: { 'User-Agent': 'ekalavya-backend', Accept: 'application/vnd.github+json' } });
    (Array.isArray(r.data) ? r.data : []).forEach(f => { if (f && f.type === 'file' && f.name) names.add(f.name); });
  } catch (e) { /* fall back to the known names */ }
  return [...names].filter(n => !SKIP.test(n) && !/[\\/]/.test(n));
}

// ── Minimal .zip writer (deflate) ───────────────────────────────────
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function dosTime(d) {
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
           date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}
function zip(files) {   // [{ name, data: Buffer }]
  const now = dosTime(new Date());
  const parts = [], central = [];
  let offset = 0;
  files.forEach(f => {
    const name = Buffer.from(f.name, 'utf8');
    const comp = zlib.deflateRawSync(f.data, { level: 9 });
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(now.time, 10); local.writeUInt16LE(now.date, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(f.data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, name, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(now.time, 12); cen.writeUInt16LE(now.date, 14); cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(f.data.length, 24); cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(0, 30); cen.writeUInt32LE(0, 34); cen.writeUInt32LE(0, 38); cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += local.length + name.length + comp.length;
  });
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

const README = version => [
  'EKALAVYA FARM AGENT' + (version ? ' v' + version : ''),
  '',
  '1. Copy this folder to the farm PC (for example C:\\ekalavya-agent).',
  '   The PC must be on the same network as the miners. One agent per PC.',
  '2. Install Node.js (LTS) from https://nodejs.org if it is not installed.',
  '3. Double-click SETUP-WINDOWS.bat. Nothing to type.',
  '   It installs what it needs, runs in the background and updates itself.',
  '4. In the app: Remote Access > New agents > pick this PC\'s farm (or type',
  '   a new farm name) > Assign. It starts polling straight away.',
  '',
  'Check it:   pm2 status          Logs:   pm2 logs ekl-agent',
  '',
].join('\r\n');

let cache = null, building = null;
async function build() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache;
  if (building) return building;
  building = (async () => {
    const names = await listNames();
    const got = await Promise.all(names.map(async n => ({ name: n, data: await fetchFile(n) })));
    const have = got.filter(f => f.data && f.data.length);
    const missing = REQUIRED.filter(n => !have.some(f => f.name === n));
    if (missing.length) return { ok: false, error: 'Could not get the agent files from GitHub (' + missing.join(', ') + '). Try again in a minute.' };
    let version = null;
    const man = have.find(f => f.name === 'manifest.json');
    if (man) { try { version = JSON.parse(man.data.toString('utf8')).version || null; } catch (e) {} }
    const files = have.map(f => {
      let data = f.data;
      // Windows batch files must have CRLF line ends, whatever the repo stores
      if (/\.bat$/i.test(f.name)) data = Buffer.from(data.toString('utf8').replace(/\r?\n/g, '\r\n'), 'utf8');
      return { name: FOLDER + '/' + f.name, data };
    }).sort((a, b) => a.name.localeCompare(b.name));
    // SETUP runs "npm install": without a package.json nothing would be installed
    if (!have.some(f => f.name === 'package.json')) files.push({ name: FOLDER + '/package.json', data: Buffer.from(JSON.stringify({
      name: 'ekalavya-agent', version: version || '1.0.0', private: true, main: 'update-check.js',
      scripts: { start: 'node update-check.js' }, dependencies: { ws: '^8.16.0', dotenv: '^16.4.0' } }, null, 2), 'utf8') });
    if (!have.some(f => /^readme/i.test(f.name))) files.push({ name: FOLDER + '/README.txt', data: Buffer.from(README(version), 'utf8') });
    const buf = zip(files);
    cache = { ok: true, at: Date.now(), buffer: buf, version, files: files.map(f => f.name.slice(FOLDER.length + 1)),
              filename: `ekalavya-agent${version ? '-v' + version : ''}.zip` };
    console.log(`[AGENT-PKG] Built ${cache.filename}: ${files.length} files, ${(buf.length / 1024).toFixed(0)} KB`);
    return cache;
  })();
  try { return await building; } finally { building = null; }
}

module.exports = { build, zip, crc32, _reset: () => { cache = null; } };
