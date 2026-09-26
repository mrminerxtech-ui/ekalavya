// ============================================================
// ACTIONS ROUTES  /api/actions
// Miner control: restart, reboot, sleep, wake, led, chiptest,
// setworkerid, setpool, overclock, factoryreset, logs, disable,
// enable, delete
//
// IMPORTANT: the backend has no direct network path to a miner's
// private farm IP (same reason the Web UI needed a tunnel) — every
// action that talks to the miner itself is routed through the
// connected farm agent via sendActionRequest(), which executes the
// real command locally (the agent has actual LAN access) and sends
// the result back over the same WebSocket connection.
//
// PERMISSIONS MODEL:
//   admin/manager/technician — full access to everything
//   customer                 — self-service on their OWN assigned
//                               machines only: restart, reboot, sleep,
//                               wake, led, chiptest, setworkerid,
//                               setpool, view/download logs.
//                               Never: factory reset, overclock,
//                               disable/enable, delete.
// Every route that allows 'customer' relies on getWorkerOr404() below
// to enforce ownership (worker.cid === req.user.id) — without that
// check, opening these actions to customers at all would let any
// customer control any OTHER customer's machines too.
// ============================================================
const express  = require('express');
const router   = express.Router();
const { authMiddleware, requireRole } = require('../middleware/auth');
const db       = require('../services/db');
const agentMgr = require('../services/agentManager');

// Helper: look up a worker by ID from the REAL fleet data (PostgreSQL/
// file fallback via db.js) — not the old in-memory store.js, which is
// never populated with real fleet workers and always returns nothing.
// Also enforces per-customer ownership: a customer account may only
// ever act on a machine assigned to their own account (worker.cid).
async function getWorkerOr404(req, res) {
  const id = req.body.worker_id || req.params.id;
  const w  = await db.getWorkerById(id);
  if (!w) { res.status(404).json({ error: 'Worker not found' }); return null; }
  if (req.user?.role === 'customer' && w.cid !== req.user.id) {
    console.log(`[ACTIONS] ✗ Customer ${req.user.id} denied access to worker ${id} (not their assigned machine)`);
    res.status(403).json({ error: 'This machine is not assigned to your account' });
    return null;
  }
  return w;
}

async function persistWorkerUpdate(id, patch) {
  const all = await db.loadWorkers();
  const idx = all.findIndex(w => w.id === id);
  if (idx >= 0) {
    all[idx] = { ...all[idx], ...patch };
    await db.saveWorkers(all);
    return all[idx];
  }
  return null;
}

// Internal helper — runs a tunneled action and returns the raw result
// (used by routes that need to persist custom fields on success).
async function runTunneledActionRaw(w, action, params) {
  if (!w.farm_id) return { ok: false, error: 'This miner has no farm assigned' };
  if (!w.ip)      return { ok: false, error: 'This miner has no IP address on record' };
  try {
    return await agentMgr.sendActionRequest(w.farm_id, w.ip, action, params || {});
  } catch(e) {
    return { ok: false, error: e.message };
  }
}

// Run a tunneled action against the miner via its farm agent, with
// consistent error handling shared across every simple action route.
async function runTunneledAction(req, res, action, params) {
  const w = await getWorkerOr404(req, res);
  if (!w) return;
  const result = await runTunneledActionRaw(w, action, params);
  if (!result.ok) return res.status(502).json({ error: result.error || 'Action failed on the miner' });
  res.json({ ok: true, action, message: result.message || `${action} sent to ${w.name}`, ...result });
}

// ── Simple no-parameter actions — customer self-service allowed ──
router.post('/restart', authMiddleware, requireRole('admin','manager','technician','customer'), async (req, res) => {
  await runTunneledAction(req, res, 'restart');
});

router.post('/reboot', authMiddleware, requireRole('admin','manager','technician','customer'), async (req, res) => {
  const w = await getWorkerOr404(req, res); if (!w) return;
  await persistWorkerUpdate(w.id, { status: 'rebooting', last_action: 'reboot', last_action_at: new Date().toISOString() });
  // brand/model let the agent use Canaan's own reboot command on Avalons
  const result = await runTunneledActionRaw(w, 'reboot', { brand: w.brand, model: w.model });
  if (!result.ok) return res.status(502).json({ error: result.error || 'Reboot failed' });
  res.json({ ok: true, action: 'reboot', message: result.message || `Hard reboot sent to ${w.name}` });
});

router.post('/sleep', authMiddleware, requireRole('admin','manager','technician','customer'), async (req, res) => {
  const w = await getWorkerOr404(req, res); if (!w) return;
  await persistWorkerUpdate(w.id, { status: 'sleeping', last_action: 'sleep', last_action_at: new Date().toISOString() });
  const result = await runTunneledActionRaw(w, 'sleep');
  if (!result.ok) return res.status(502).json({ error: result.error || 'Sleep failed' });
  res.json({ ok: true, action: 'sleep', message: result.message || `${w.name} entering sleep mode` });
});

router.post('/wake', authMiddleware, requireRole('admin','manager','technician','customer'), async (req, res) => {
  const w = await getWorkerOr404(req, res); if (!w) return;
  await persistWorkerUpdate(w.id, { status: 'online', last_action: 'wake', last_action_at: new Date().toISOString() });
  const result = await runTunneledActionRaw(w, 'wake');
  if (!result.ok) return res.status(502).json({ error: result.error || 'Wake failed' });
  res.json({ ok: true, action: 'wake', message: result.message || `${w.name} waking up` });
});

// Locate a machine by its LED. brand/model tell the agent which command
// the miner speaks (Avalon: Canaan's ascset LED; Antminer: blink.cgi).
// minutes = switch the LED off again automatically (default 10, 0 = stay
// on until someone turns it off).
router.post('/led', authMiddleware, requireRole('admin','manager','technician','customer'), async (req, res) => {
  const w = await getWorkerOr404(req, res); if (!w) return;
  const on = req.body.on !== false;
  const minutes = req.body.minutes === undefined ? 10 : Math.max(0, Math.min(120, parseInt(req.body.minutes, 10) || 0));
  const result = await runTunneledActionRaw(w, 'led', { on, minutes, brand: w.brand, model: w.model });
  if (!result.ok) return res.status(502).json({ error: result.error || 'LED command failed' });
  // Not stored on the machine record: the agent switches it off on its
  // own after `minutes`, so a saved "on" flag would soon be wrong.
  res.json({ ok: true, action: 'led', on, message: result.message || `LED ${on ? 'on' : 'off'} on ${w.name}` });
});

// ── Avalon (Canaan) tuning — staff only. Commands taken from Canaan's
// own management tool; see the notes in agent.js (avalonAscset). ──
function requireAvalon(w, res) {
  if (/avalon|canaan/i.test(`${w.brand || ''} ${w.model || ''}`)) return true;
  res.status(400).json({ error: 'These controls are for Avalon (Canaan) miners only' });
  return false;
}
router.post('/workmode', authMiddleware, requireRole('admin','manager','technician'), async (req, res) => {
  const w = await getWorkerOr404(req, res); if (!w) return;
  if (!requireAvalon(w, res)) return;
  const mode = parseInt(req.body.mode, 10);
  if (mode !== 0 && mode !== 1) return res.status(400).json({ error: 'mode must be 0 (Normal) or 1 (High Performance)' });
  const reboot = req.body.reboot !== false;
  const result = await runTunneledActionRaw(w, 'avalon_workmode', { mode, reboot, brand: w.brand, model: w.model });
  if (!result.ok) return res.status(502).json({ error: result.error || 'Work mode change failed' });
  await persistWorkerUpdate(w.id, { work_mode: mode === 1 ? 'high' : 'normal', last_action: 'workmode', last_action_at: new Date().toISOString() });
  console.log(`[ACTIONS] ${w.name} (${w.ip}) work mode → ${mode === 1 ? 'High Performance' : 'Normal'} by ${req.user?.name || req.user?.id}`);
  res.json({ ok: true, action: 'workmode', message: result.message });
});
router.post('/fanspeed', authMiddleware, requireRole('admin','manager','technician'), async (req, res) => {
  const w = await getWorkerOr404(req, res); if (!w) return;
  if (!requireAvalon(w, res)) return;
  const speed = parseInt(req.body.speed, 10);
  if (!(speed === -1 || (speed >= 30 && speed <= 100))) return res.status(400).json({ error: 'speed must be -1 (auto) or 30–100' });
  const result = await runTunneledActionRaw(w, 'avalon_fan', { speed, brand: w.brand, model: w.model });
  if (!result.ok) return res.status(502).json({ error: result.error || 'Fan speed change failed' });
  console.log(`[ACTIONS] ${w.name} (${w.ip}) fan → ${speed === -1 ? 'auto' : speed + '%'} by ${req.user?.name || req.user?.id}`);
  res.json({ ok: true, action: 'fanspeed', message: result.message });
});

router.post('/chiptest', authMiddleware, requireRole('admin','manager','technician','customer'), async (req, res) => {
  await runTunneledAction(req, res, 'chiptest');
});

// ── Staff-only — risk of data loss / hardware damage / warranty ──
router.post('/factoryreset', authMiddleware, requireRole('admin'), async (req, res) => {
  if (!req.body.confirmed) return res.status(400).json({ error: 'confirmed:true required for factory reset' });
  await runTunneledAction(req, res, 'factoryreset');
});

router.post('/overclock', authMiddleware, requireRole('admin'), async (req, res) => {
  const { mode, freq_pct, fan_pct } = req.body;
  await runTunneledAction(req, res, 'overclock', { mode, freq_pct, fan_pct });
});

router.post('/firmware', authMiddleware, requireRole('admin'), async (req, res) => {
  const w = await getWorkerOr404(req, res); if (!w) return;
  const { firmware_url, firmware_version } = req.body;
  if (!firmware_url) return res.status(400).json({ error: 'firmware_url required' });
  const result = await runTunneledActionRaw(w, 'firmware', { firmware_url });
  if (!result.ok) return res.status(502).json({ error: result.error || 'Firmware upgrade failed' });
  await persistWorkerUpdate(w.id, { status: 'upgrading', firmware_target: firmware_version, last_action: 'firmware' });
  res.json({ ok: true, action: 'firmware', message: result.message || `Firmware upgrade started on ${w.name}`, warning: 'Do NOT power off. Takes 3-5 minutes.' });
});

// ── Logs — customer self-service allowed, ownership-checked ──
router.post('/fetchlogs', authMiddleware, requireRole('admin','manager','technician','customer'), async (req, res) => {
  await runTunneledAction(req, res, 'fetchlogs');
});

router.post('/downloadlogs', authMiddleware, requireRole('admin','manager','technician','customer'), async (req, res) => {
  await runTunneledAction(req, res, 'downloadlogs');
});

// ── Parameterized actions — customer self-service allowed ──
router.post('/setworkerid', authMiddleware, requireRole('admin','manager','customer'), async (req, res) => {
  const w = await getWorkerOr404(req, res); if (!w) return;
  const { new_worker_id } = req.body;
  if (!new_worker_id) return res.status(400).json({ error: 'new_worker_id required' });
  const poolParts = (w.pool_user || w.worker_id || 'wallet.worker').split('.');
  const newUser = `${poolParts[0]}.${new_worker_id}`;
  const result = await runTunneledActionRaw(w, 'setworkerid', { pool_url: w.pool_url, new_user: newUser });
  if (!result.ok) return res.status(502).json({ error: result.error || 'Failed to update worker ID' });
  await persistWorkerUpdate(w.id, { name: new_worker_id, worker_id: newUser, pool_user: newUser, last_action: 'setworkerid' });
  res.json({ ok: true, action: 'setworkerid', worker_id: new_worker_id, message: `Worker ID updated to ${new_worker_id}` });
});

router.post('/setpool', authMiddleware, requireRole('admin','manager','customer'), async (req, res) => {
  const w = await getWorkerOr404(req, res); if (!w) return;
  const { pool_url, pool_user, pool_pass, pool_url2, pool_user2, pool_url3, pool_user3 } = req.body;
  if (!pool_url || !pool_user) return res.status(400).json({ error: 'pool_url and pool_user required' });
  const result = await runTunneledActionRaw(w, 'setpool', { pool_url, pool_user, pool_pass, pool_url2, pool_user2, pool_url3, pool_user3 });
  if (!result.ok) return res.status(502).json({ error: result.error || 'Failed to update pool' });
  await persistWorkerUpdate(w.id, { pool: pool_url, pool_url, pool_user, last_action: 'setpool' });
  res.json({ ok: true, action: 'setpool', pool: pool_url, message: `Pool updated on ${w.name}` });
});

// ── Disable / Enable / Delete — staff-only repair & fleet
// management workflow, no agent tunnel needed for disable/enable ──
router.post('/disable', authMiddleware, requireRole('admin','manager','technician'), async (req, res) => {
  const w = await getWorkerOr404(req, res); if (!w) return;
  const { reason = 'Taken for repair' } = req.body;
  await persistWorkerUpdate(w.id, { disabled: true, disabled_reason: reason, disabled_at: new Date().toISOString(), status: 'disabled', last_action: 'disable' });
  res.json({ ok: true, action: 'disable', message: `${w.name} disabled: ${reason}` });
});

router.post('/enable', authMiddleware, requireRole('admin','manager','technician'), async (req, res) => {
  const w = await getWorkerOr404(req, res); if (!w) return;
  await persistWorkerUpdate(w.id, { disabled: false, disabled_reason: null, disabled_at: null, status: 'offline', last_action: 'enable' });
  res.json({ ok: true, action: 'enable', message: `${w.name} re-enabled` });
});

// ── Delete from fleet (POST, matches the frontend's doAction()
// calling convention — separate from any REST-style DELETE route) ──
router.post('/delete', authMiddleware, requireRole('admin'), async (req, res) => {
  const w = await getWorkerOr404(req, res); if (!w) return;
  // Deletion must be an explicit, targeted removal — not achieved by
  // simply omitting the worker from a bulk save. saveWorkers() now
  // upserts by id and never removes records absent from the list it's
  // given, which is what keeps normal saves from other sessions safe;
  // an actual delete needs its own explicit operation instead.
  await db.deleteWorker(w.id);
  res.json({ ok: true, action: 'delete', message: `${w.name} removed from fleet` });
});

module.exports = router;
