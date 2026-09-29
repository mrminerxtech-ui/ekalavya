// ============================================================
// FARMS & AGENT PCs
// ------------------------------------------------------------
// A farm used to BE whatever FARM_ID a PC had in its .env file, so
// editing that file (or setting up a new PC slightly differently)
// silently created a second farm, and its machines were split between
// the two ("Farm_4" online with 0 machines next to "Farm_4" offline
// with 67).
//
// Now the two are separate:
//   • A FARM has a fixed internal id and a name typed in the app. The
//     name can be changed any time; nothing else changes with it.
//   • An AGENT PC identifies itself by a permanent id derived from the
//     PC itself (Windows MachineGuid), and the app decides which farm it
//     belongs to.
//
// A PC the app has never seen waits as "new" until someone picks its
// farm in Remote Access. A PC that still has FARM_ID in its .env (every
// agent installed before this) and the right agent key is linked to
// that farm automatically the first time, so nothing already running
// changes.
//
// Stored in app_settings under 'farm_registry':
//   { farms:  { <farm_id>: { name, created_at } },
//     agents: { <pc_id>:   { farm_id, hostname, first_seen, last_seen, ips, subnets } } }
// ============================================================
const db = require('./db');

const KEY = 'farm_registry';
let reg = null;               // in-memory copy, source of truth after load
let loading = null;
let writing = Promise.resolve();
const pending = new Map();    // pc_id -> { pc_id, hostname, ips, subnets, version, connected_at, ws, key_ok, farm_hint }
const MAX_PENDING = 20;

function blank() { return { farms: {}, agents: {} }; }

let loadedWithoutDb = false;
async function load() {
  // Loaded while the database was still unreachable → load again once it
  // is, so a slow database start never leaves the farm list empty.
  if (reg && !(loadedWithoutDb && db.isUsingDB())) return reg;
  if (loading) return loading;
  loading = (async () => {
    try { await db.connect(); } catch (e) {}
    loadedWithoutDb = !db.isUsingDB();
    let v = null;
    try { v = await db.getSetting(KEY); } catch (e) {}
    reg = (v && typeof v === 'object' && v.farms && v.agents) ? v : blank();
    await seedFromExisting();
    return reg;
  })();
  try { return await loading; } finally { loading = null; }
}

// Farms that exist only in machine records or the old per-farm config
// (every farm from before this change) get a registry entry with their
// current name, so they appear in the farm list and can be renamed.
async function seedFromExisting() {
  let changed = false;
  try {
    const workers = await db.loadWorkers();
    const names = new Map();
    workers.forEach(w => {
      if (!w || !w.farm_id) return;
      if (!names.has(w.farm_id) || (w.farm && w.farm !== w.farm_id)) names.set(w.farm_id, w.farm || names.get(w.farm_id) || w.farm_id);
    });
    try { (await db.loadAllAgentConfigs() || []).forEach(c => { if (c && c.farm_id && c.name && !names.has(c.farm_id)) names.set(c.farm_id, c.name); }); } catch (e) {}
    names.forEach((name, id) => {
      if (!reg.farms[id]) { reg.farms[id] = { name: String(name || id), created_at: new Date().toISOString() }; changed = true; }
    });
  } catch (e) { console.error('[FARMS] seed error:', e.message); }
  if (changed) await persist();
}

function persist() {
  const snapshot = JSON.parse(JSON.stringify(reg));
  const p = writing.then(() => db.setSetting(KEY, snapshot, 'farms'));
  writing = p.catch(() => {});
  return p;
}

function newFarmId(name) {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'farm';
  let id = 'farm-' + slug, n = 2;
  while (reg.farms[id]) id = 'farm-' + slug + '-' + (n++);
  return id;
}
function cleanName(name) { return String(name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60); }
function farmName(id) { return (reg && reg.farms[id] && reg.farms[id].name) || id; }

// ── Connection time ────────────────────────────────────────────────
// → { farm_id, farm_name, linked:'known'|'legacy' } or { pending:true }
async function resolveAgent({ pcId, legacyFarmId, legacySource, legacyName, hostname, keyOk, ips, subnets, version }) {
  await load();
  const now = new Date().toISOString();
  if (pcId && reg.agents[pcId] && reg.agents[pcId].farm_id) {
    const a = reg.agents[pcId];
    Object.assign(a, { hostname: hostname || a.hostname, last_seen: now, ips: ips || a.ips, subnets: subnets || a.subnets, version: version || a.version });
    if (!reg.farms[a.farm_id]) reg.farms[a.farm_id] = { name: cleanName(legacyName) || a.farm_id, created_at: now };
    persist().catch(() => {});
    return { farm_id: a.farm_id, farm_name: farmName(a.farm_id), linked: 'known' };
  }
  // An agent that names its farm in .env (all agents installed before
  // this change) is linked to it — only with the real agent key.
  // legacySource 'default' = the agent's own fallback id farm-<pc name>
  // (no FARM_ID in .env): only linked when that farm already exists, so a
  // brand-new PC waits for the app instead of inventing a farm.
  if (legacyFarmId && keyOk && (legacySource !== 'default' || reg.farms[legacyFarmId])) {
    if (!reg.farms[legacyFarmId]) reg.farms[legacyFarmId] = { name: cleanName(legacyName) || legacyFarmId, created_at: now };
    if (pcId) {
      reg.agents[pcId] = { farm_id: legacyFarmId, hostname, first_seen: now, last_seen: now, ips, subnets, version };
      console.log(`[FARMS] PC ${hostname || pcId} linked to farm "${farmName(legacyFarmId)}" (${legacyFarmId}) from its .env`);
    }
    persist().catch(() => {});
    return { farm_id: legacyFarmId, farm_name: farmName(legacyFarmId), linked: 'legacy' };
  }
  return { pending: true };
}

// Suggest a farm for a new PC: an offline farm whose machines sit on one
// of the subnets this PC is directly attached to.
function suggestFarm(ips, onlineFarmIds, workers) {
  const nets = (ips || []).map(ip => String(ip).split('.').slice(0, 3).join('.'));
  if (!nets.length) return null;
  const score = new Map();
  (workers || []).forEach(w => {
    if (!w || !w.ip || !w.farm_id || onlineFarmIds.has(w.farm_id)) return;
    if (nets.includes(String(w.ip).split('.').slice(0, 3).join('.'))) score.set(w.farm_id, (score.get(w.farm_id) || 0) + 1);
  });
  let best = null; score.forEach((n, id) => { if (!best || n > best.n) best = { id, n }; });
  return best ? best.id : null;
}

function addPending(info) {
  if (!pending.has(info.pc_id) && pending.size >= MAX_PENDING) return false;
  pending.set(info.pc_id, info);
  return true;
}
function removePending(pcId, ws) {
  const p = pending.get(pcId);
  if (p && (!ws || p.ws === ws)) pending.delete(pcId);
}
function listPending() {
  return [...pending.values()].map(p => ({ pc_id: p.pc_id, hostname: p.hostname, ips: p.ips || [], subnets: p.subnets || [],
    version: p.version, connected_at: p.connected_at, key_ok: !!p.key_ok, suggested_farm_id: p.suggested_farm_id || null }));
}

// ── Changes from the app ───────────────────────────────────────────
// Put a PC on a farm (existing farm_id, or a new farm with typed name).
async function assignAgent(pcId, { farm_id, new_farm_name }, by) {
  await load();
  if (!pcId) return { ok: false, error: 'No PC given' };
  const p = pending.get(pcId);
  const prev = reg.agents[pcId];
  if (!p && !prev) return { ok: false, error: 'That PC is not known — is its agent running?' };
  let fid = farm_id;
  if (!fid) {
    const name = cleanName(new_farm_name);
    if (!name) return { ok: false, error: 'Type a farm name' };
    fid = newFarmId(name);
    reg.farms[fid] = { name, created_at: new Date().toISOString(), created_by: by || null };
  } else if (!reg.farms[fid]) return { ok: false, error: 'That farm does not exist' };
  reg.agents[pcId] = Object.assign({}, prev || {}, {
    farm_id: fid,
    hostname: (p && p.hostname) || (prev && prev.hostname),
    ips: (p && p.ips) || (prev && prev.ips), subnets: (p && p.subnets) || (prev && prev.subnets),
    first_seen: (prev && prev.first_seen) || new Date().toISOString(),
    assigned_by: by || null, assigned_at: new Date().toISOString(),
  });
  await persist();
  console.log(`[FARMS] PC ${reg.agents[pcId].hostname || pcId} → farm "${farmName(fid)}" (${fid})${by ? ' by ' + by : ''}`);
  return { ok: true, farm_id: fid, farm_name: farmName(fid), was_farm_id: prev ? prev.farm_id : null, pending_ws: p ? p.ws : null };
}

async function renameFarm(fid, name, by) {
  await load();
  const n = cleanName(name);
  if (!n) return { ok: false, error: 'Type a farm name' };
  if (!reg.farms[fid]) return { ok: false, error: 'That farm does not exist' };
  const old = reg.farms[fid].name;
  reg.farms[fid].name = n;
  await persist();
  try { await db.setFarmNameOnWorkers(fid, n); } catch (e) {}
  console.log(`[FARMS] Farm ${fid} renamed "${old}" → "${n}"${by ? ' by ' + by : ''}`);
  return { ok: true, farm_id: fid, name: n, old };
}

// Move every machine and PC of one farm into another, then drop it.
async function mergeFarm(fromId, intoId, by) {
  await load();
  if (!reg.farms[fromId] || !reg.farms[intoId]) return { ok: false, error: 'Farm not found' };
  if (fromId === intoId) return { ok: false, error: 'Choose a different farm' };
  const moved = await db.moveWorkersToFarm(fromId, intoId, farmName(intoId));
  const pcs = [];
  Object.entries(reg.agents).forEach(([pc, a]) => { if (a.farm_id === fromId) { a.farm_id = intoId; pcs.push(pc); } });
  const fromName = farmName(fromId);
  delete reg.farms[fromId];
  await persist();
  console.log(`[FARMS] Farm "${fromName}" (${fromId}) merged into "${farmName(intoId)}" (${intoId}): ${moved} machine record(s), ${pcs.length} PC(s)${by ? ' by ' + by : ''}`);
  return { ok: true, moved, pcs };
}

async function deleteFarm(fid, machineCount, by) {
  await load();
  if (!reg.farms[fid]) return { ok: false, error: 'That farm does not exist' };
  if (machineCount > 0) return { ok: false, error: `It still has ${machineCount} machine(s) — merge it into another farm instead` };
  const pcs = Object.entries(reg.agents).filter(([, a]) => a.farm_id === fid).map(([pc]) => pc);
  if (pcs.length) return { ok: false, error: `PC ${reg.agents[pcs[0]].hostname || pcs[0]} is on this farm — move it to another farm first` };
  const name = farmName(fid);
  delete reg.farms[fid];
  await persist();
  console.log(`[FARMS] Farm "${name}" (${fid}) deleted${by ? ' by ' + by : ''}`);
  return { ok: true };
}

// Forget a PC that is no longer used (it waits as new if it ever returns).
async function forgetAgent(pcId, by) {
  await load();
  if (!reg.agents[pcId]) return { ok: false, error: 'Unknown PC' };
  const h = reg.agents[pcId].hostname;
  delete reg.agents[pcId];
  await persist();
  console.log(`[FARMS] PC ${h || pcId} forgotten${by ? ' by ' + by : ''}`);
  return { ok: true };
}

// IP ranges the agent polls, set in the app (Remote Access → IP Ranges).
async function setSubnets(fid, subnets, by) {
  await load();
  if (!reg.farms[fid]) reg.farms[fid] = { name: fid, created_at: new Date().toISOString() };
  const list = (Array.isArray(subnets) ? subnets : []).map(x => String(x).trim()).filter(Boolean).slice(0, 32);
  reg.farms[fid].subnets = list;
  await persist();
  console.log(`[FARMS] IP ranges for "${farmName(fid)}": ${list.join(', ') || '(auto-detect)'}${by ? ' by ' + by : ''}`);
  return list;
}
function subnetsFor(fid) { return (reg && reg.farms[fid] && reg.farms[fid].subnets) || []; }

// Networks (as /24s) this farm's machine records sit on. Sent to the
// farm's agent so it always polls every network its machines are on,
// even when no IP ranges were typed in — a farm spread over two networks
// used to be half-polled (the other half showed offline).
function knownSubnetsFor(fid, workers) {
  const nets = new Set();
  (workers || []).forEach(w => {
    if (!w || w.farm_id !== fid || !w.ip) return;
    const p = String(w.ip).split('.');
    if (p.length === 4 && p.every(x => /^\d{1,3}$/.test(x))) nets.add(p.slice(0, 3).join('.') + '.0/24');
  });
  return [...nets].sort().slice(0, 32);
}
// Every few minutes: if a farm's machines turned up on a new network
// (e.g. added with the Network Scanner), tell its agent.
const lastKnownSent = new Map();
function startKnownSubnetSync(agentMgr) {
  setInterval(async () => {
    try {
      const workers = await db.loadWorkers();
      agentMgr.getAgents().forEach(a => {
        const list = knownSubnetsFor(a.farm_id, workers);
        const key = list.join(',');
        if (lastKnownSent.get(a.farm_id) === key) return;
        if (agentMgr.sendToAgent(a.farm_id, { type: 'set_subnets', known_subnets: list })) lastKnownSent.set(a.farm_id, key);
      });
    } catch (e) {}
  }, 5 * 60 * 1000).unref();
}
function noteKnownSent(fid, list) { lastKnownSent.set(fid, (list || []).join(',')); }

function snapshot() { return reg ? JSON.parse(JSON.stringify(reg)) : blank(); }

module.exports = { load, resolveAgent, suggestFarm, addPending, removePending, listPending, assignAgent, renameFarm,
                   mergeFarm, deleteFarm, forgetAgent, farmName, snapshot, setSubnets, subnetsFor, knownSubnetsFor, startKnownSubnetSync, noteKnownSent, _pending: pending, _reset: () => { reg = null; pending.clear(); } };
