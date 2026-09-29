// ============================================================
// FARMS ROUTE  /api/farms  — see services/farms.js
// ------------------------------------------------------------
// GET    /api/farms                   farms (name, machines, PCs) + PCs waiting for a farm
// POST   /api/farms/assign            { pc_id, farm_id | new_farm_name }  put a PC on a farm
// POST   /api/farms/:id/rename        { name }
// POST   /api/farms/:id/merge         { into }   move all machines + PCs, remove this farm
// DELETE /api/farms/:id               an empty farm with no PC
// DELETE /api/farms/pc/:pcId          forget a PC that is no longer used
// Reading: any staff account. Changing: admin or manager.
// ============================================================
const express  = require('express');
const router   = express.Router();
const { authMiddleware, requireRole } = require('../middleware/auth');
const farms    = require('../services/farms');
const agentMgr = require('../services/agentManager');
const db       = require('../services/db');

function staffOnly(req, res, next) {
  if ((req.user && req.user.role) === 'customer') return res.status(403).json({ ok: false, error: 'Forbidden' });
  next();
}
const who = req => (req.user && (req.user.name || req.user.id)) || 'unknown';
const canChange = requireRole('admin', 'manager');

// This farm's machines per network (/24), in service only: how many and
// how many online. A whole network at 0 online = most likely not polled.
function networksOf(fid, workers) {
  const m = new Map();
  workers.forEach(w => {
    if (!w || w.farm_id !== fid || !w.ip || w.disabled) return;
    const net = String(w.ip).split('.').slice(0, 3).join('.');
    const e = m.get(net) || { net, total: 0, online: 0 };
    e.total++; if (w.status === 'online') e.online++;
    m.set(net, e);
  });
  return [...m.values()].sort((a, b) => a.net.localeCompare(b.net, undefined, { numeric: true }));
}

async function overview() {
  await farms.load();
  const reg = farms.snapshot();
  const workers = await db.loadWorkers();
  const online = agentMgr.getAgents();
  const count = new Map();
  workers.forEach(w => { if (w && w.farm_id) count.set(w.farm_id, (count.get(w.farm_id) || 0) + 1); });
  const pcsByFarm = new Map();
  Object.entries(reg.agents).forEach(([pc, a]) => {
    const live = online.find(o => o.pc_id === pc);
    const row = { pc_id: pc, hostname: a.hostname || '', ips: a.ips || [], last_seen: a.last_seen || null, online: !!live, version: a.version || null };
    if (!pcsByFarm.has(a.farm_id)) pcsByFarm.set(a.farm_id, []);
    pcsByFarm.get(a.farm_id).push(row);
  });
  const ids = new Set([...Object.keys(reg.farms), ...count.keys(), ...online.map(o => o.farm_id)]);
  const list = [...ids].map(id => {
    const agentNow = online.find(o => o.farm_id === id);
    const pcs = pcsByFarm.get(id) || [];
    // an older agent (no PC id) connected under this farm
    if (agentNow && !agentNow.pc_id) pcs.push({ pc_id: null, hostname: agentNow.hostname, ips: agentNow.ips || [], online: true, older_agent: true });
    return { farm_id: id, name: farms.farmName(id), machines: count.get(id) || 0, online: !!agentNow, pcs,
             subnets: (reg.farms[id] && reg.farms[id].subnets) || [],          // typed in the app ([] = automatic)
             known_subnets: farms.knownSubnetsFor(id, workers),               // networks its machines are on
             polling: (agentNow && agentNow.poll_stats) || null,              // what its agent polls right now
             networks: networksOf(id, workers) };                              // machines per /24: total / online
  }).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { ok: true, farms: list, pending: farms.listPending() };
}

router.get('/', authMiddleware, staffOnly, async (req, res) => {
  try { res.json(await overview()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Tell a connected PC its farm changed; it reconnects and comes back
// under the new farm straight away.
function kickPc(pcId, payload, pendingWs) {
  const sockets = [];
  if (pendingWs) sockets.push(pendingWs);
  const live = agentMgr.getAgents().find(a => a.pc_id === pcId);
  if (live) {
    agentMgr.sendToAgent(live.farm_id, payload);
    agentMgr.closeAgent && agentMgr.closeAgent(live.farm_id, 4010, 'Farm changed');
  }
  sockets.forEach(ws => { try { ws.send(JSON.stringify(payload)); ws.close(4010, 'Farm assigned'); } catch (e) {} });
}

router.post('/assign', authMiddleware, canChange, async (req, res) => {
  const b = req.body || {};
  const pcId = String(b.pc_id || '');
  // Two PCs on one farm knock each other offline — refuse unless the
  // PC already on it is offline.
  if (b.farm_id) {
    const onIt = agentMgr.getAgent(b.farm_id);
    if (onIt && onIt.pc_id !== pcId) {
      return res.status(409).json({ ok: false, error: `${farms.farmName(b.farm_id)} already has an agent online (PC ${onIt.hostname}). Only one PC can run a farm — stop or move that one first.` });
    }
  }
  const r = await farms.assignAgent(pcId, { farm_id: b.farm_id, new_farm_name: b.new_farm_name }, who(req));
  if (!r.ok) return res.status(400).json(r);
  kickPc(pcId, { type: 'assigned', farm_id: r.farm_id, farm_name: r.farm_name }, r.pending_ws);
  farms.removePending(pcId);
  res.json({ ok: true, farm_id: r.farm_id, farm_name: r.farm_name, ...(await overview()) });
});

router.post('/:id/rename', authMiddleware, canChange, async (req, res) => {
  const r = await farms.renameFarm(req.params.id, (req.body || {}).name, who(req));
  if (!r.ok) return res.status(400).json(r);
  agentMgr.setFarmName && agentMgr.setFarmName(req.params.id, r.name);
  agentMgr.sendToAgent(req.params.id, { type: 'farm_renamed', farm_id: req.params.id, farm_name: r.name });
  try { require('../websocket').broadcast({ type: 'farm_renamed', farm_id: req.params.id, name: r.name }); } catch (e) {}
  res.json({ ok: true, ...(await overview()) });
});

router.post('/:id/merge', authMiddleware, canChange, async (req, res) => {
  const into = (req.body || {}).into;
  const from = req.params.id;
  if (agentMgr.getAgent(from) && agentMgr.getAgent(into)) {
    return res.status(409).json({ ok: false, error: 'Both farms have an agent online — stop one of them first (only one PC can run a farm).' });
  }
  const r = await farms.mergeFarm(from, into, who(req));
  if (!r.ok) return res.status(400).json(r);
  // A PC that was running the merged farm reconnects under the new one.
  r.pcs.forEach(pc => kickPc(pc, { type: 'assigned', farm_id: into, farm_name: farms.farmName(into) }));
  if (agentMgr.getAgent(from)) agentMgr.closeAgent && agentMgr.closeAgent(from, 4010, 'Farm merged');
  try { require('../websocket').broadcast({ type: 'farms_changed' }); } catch (e) {}
  res.json({ ok: true, moved: r.moved, ...(await overview()) });
});

router.delete('/pc/:pcId', authMiddleware, canChange, async (req, res) => {
  if (agentMgr.getAgents().some(a => a.pc_id === req.params.pcId)) return res.status(409).json({ ok: false, error: 'That PC is online — stop its agent first.' });
  const r = await farms.forgetAgent(req.params.pcId, who(req));
  if (!r.ok) return res.status(400).json(r);
  res.json({ ok: true, ...(await overview()) });
});

router.delete('/:id', authMiddleware, canChange, async (req, res) => {
  const id = req.params.id;
  if (agentMgr.getAgent(id)) return res.status(409).json({ ok: false, error: 'Its agent is online — move that PC to another farm first.' });
  const n = (await db.loadWorkers()).filter(w => w && w.farm_id === id).length;
  const r = await farms.deleteFarm(id, n, who(req));
  if (!r.ok) return res.status(400).json(r);
  res.json({ ok: true, ...(await overview()) });
});

module.exports = router;
