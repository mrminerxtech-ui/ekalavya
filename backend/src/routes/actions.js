// ============================================================
// ACTIONS ROUTES  /api/actions
// Full miner control: restart, reboot, sleep, delete,
// logs, factory reset, firmware upgrade, disable, worker/pool
// ============================================================
const express = require('express');
const router  = express.Router();
const { authMiddleware, requireRole } = require('../middleware/auth');
const store   = require('../services/store');
const { sendCommand }  = require('../services/cgminer');
const { rebootAntminer, setAntminerPool, antminerRequest } = require('../services/antminer');

// Helper: get worker or 404
function getWorker(req, res) {
  const w = store.getWorker(req.body.worker_id || req.params.id);
  if (!w) { res.status(404).json({ error: 'Worker not found' }); return null; }
  return w;
}

// ── RESTART (soft — restart mining software only) ─────────
router.post('/restart', authMiddleware, requireRole('admin','technician'), async (req, res) => {
  const w = getWorker(req, res); if (!w) return;
  try {
    // CGMiner restart command restarts just the miner process
    await sendCommand(w.ip, 'restart');
    store.updateWorker(w.id, { last_action: 'restart', last_action_at: new Date().toISOString() });
    res.json({ ok: true, action: 'restart', message: `Mining software restarted on ${w.name}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── REBOOT (hard — full machine reboot) ───────────────────
router.post('/reboot', authMiddleware, requireRole('admin','technician'), async (req, res) => {
  const w = getWorker(req, res); if (!w) return;
  try {
    try { await sendCommand(w.ip, 'restart'); }
    catch { await rebootAntminer(w.ip); }
    store.updateWorker(w.id, { status: 'rebooting', last_action: 'reboot', last_action_at: new Date().toISOString() });
    // Mark back online after ~60s
    setTimeout(() => store.updateWorker(w.id, { status: 'online' }), 60000);
    res.json({ ok: true, action: 'reboot', message: `Hard reboot sent to ${w.name} (${w.ip})` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SLEEP (low power mode) ────────────────────────────────
router.post('/sleep', authMiddleware, requireRole('admin','technician'), async (req, res) => {
  const w = getWorker(req, res); if (!w) return;
  try {
    // Antminer sleep via fan/power reduction; CGMiner: zero-out intensity
    try { await sendCommand(w.ip, 'zero', '', w.cgminer_port); }
    catch { await antminerRequest(w.ip, '/cgi-bin/set_miner_conf.cgi', 'POST', { sleep: 1 }); }
    store.updateWorker(w.id, { status: 'sleeping', last_action: 'sleep', last_action_at: new Date().toISOString() });
    res.json({ ok: true, action: 'sleep', message: `${w.name} entering low-power sleep mode` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DISABLE (for repair — keeps in fleet but marks unavailable)
router.post('/disable', authMiddleware, requireRole('admin','manager'), async (req, res) => {
  const w = getWorker(req, res); if (!w) return;
  const { reason = 'Taken for repair' } = req.body;
  store.updateWorker(w.id, { disabled: true, disabled_reason: reason, disabled_at: new Date().toISOString(), status: 'disabled', last_action: 'disable' });
  res.json({ ok: true, action: 'disable', message: `${w.name} disabled: ${reason}` });
});

// ── ENABLE (re-enable after repair) ──────────────────────
router.post('/enable', authMiddleware, requireRole('admin','manager'), async (req, res) => {
  const w = getWorker(req, res); if (!w) return;
  store.updateWorker(w.id, { disabled: false, disabled_reason: null, disabled_at: null, status: 'offline', last_action: 'enable' });
  res.json({ ok: true, action: 'enable', message: `${w.name} re-enabled` });
});

// ── DELETE (remove from fleet entirely) ──────────────────
router.delete('/:id', authMiddleware, requireRole('admin'), (req, res) => {
  const w = store.getWorker(req.params.id);
  if (!w) return res.status(404).json({ error: 'Not found' });
  store.removeWorker(req.params.id);
  res.json({ ok: true, action: 'delete', message: `${w.name} removed from fleet` });
});

// ── GET LOGS ──────────────────────────────────────────────
router.get('/logs/:worker_id', authMiddleware, async (req, res) => {
  const w = store.getWorker(req.params.worker_id);
  if (!w) return res.status(404).json({ error: 'Not found' });
  try {
    // Try CGMiner log file read via custom command
    const result = await sendCommand(w.ip, 'check');
    const logs = result?.STATUS?.[0]?.Msg || 'No log data from CGMiner API';
    // Also try Antminer log endpoint
    res.json({ ok: true, worker: w.name, ip: w.ip, source: 'cgminer', logs, fetched_at: new Date().toISOString() });
  } catch {
    try {
      const data = await antminerRequest(w.ip, '/cgi-bin/log.cgi', 'GET');
      res.json({ ok: true, worker: w.name, ip: w.ip, source: 'http', logs: data?.log || data, fetched_at: new Date().toISOString() });
    } catch (e) {
      res.status(500).json({ error: `Cannot fetch logs from ${w.ip}: ${e.message}` });
    }
  }
});

// ── FACTORY RESET ─────────────────────────────────────────
router.post('/factory-reset', authMiddleware, requireRole('admin'), async (req, res) => {
  const w = getWorker(req, res); if (!w) return;
  const { confirmed } = req.body;
  if (!confirmed) return res.status(400).json({ error: 'confirmed:true required for factory reset' });
  try {
    await antminerRequest(w.ip, '/cgi-bin/factory_reset.cgi', 'POST', { reset: 1 });
    store.updateWorker(w.id, { status: 'resetting', pool: null, last_action: 'factory_reset', last_action_at: new Date().toISOString() });
    res.json({ ok: true, action: 'factory_reset', message: `Factory reset initiated on ${w.name}. All settings will be wiped.`, warning: 'Miner will need to be reconfigured after reset.' });
  } catch (e) {
    // Even if HTTP fails, record intent
    res.status(500).json({ error: `Factory reset command failed: ${e.message}. Try logging into the web UI directly at http://${w.ip}` });
  }
});

// ── FIRMWARE UPGRADE ──────────────────────────────────────
router.post('/firmware-upgrade', authMiddleware, requireRole('admin'), async (req, res) => {
  const w = getWorker(req, res); if (!w) return;
  const { firmware_url, firmware_version } = req.body;
  if (!firmware_url) return res.status(400).json({ error: 'firmware_url required' });
  try {
    // Antminer firmware upgrade via HTTP POST (multipart in production)
    await antminerRequest(w.ip, '/cgi-bin/upgrade.cgi', 'POST', { url: firmware_url });
    store.updateWorker(w.id, { status: 'upgrading', firmware_upgrading: true, firmware_target: firmware_version, last_action: 'firmware_upgrade', last_action_at: new Date().toISOString() });
    res.json({ ok: true, action: 'firmware_upgrade', message: `Firmware upgrade started on ${w.name} → ${firmware_version}`, warning: 'Do NOT power off. Takes 3-5 minutes.' });
  } catch (e) {
    res.status(500).json({ error: `Firmware upgrade failed: ${e.message}. Upload via web UI at http://${w.ip}` });
  }
});

// ── CHANGE WORKER ID ──────────────────────────────────────
router.post('/set-worker-id', authMiddleware, requireRole('admin','manager'), async (req, res) => {
  const w = getWorker(req, res); if (!w) return;
  const { worker_id } = req.body;
  if (!worker_id) return res.status(400).json({ error: 'worker_id required' });
  try {
    // Worker ID is embedded in pool user string: pool.worker_id
    const poolParts = (w.pool_user || 'wallet.worker').split('.');
    const newUser   = `${poolParts[0]}.${worker_id}`;
    await antminerRequest(w.ip, '/cgi-bin/set_miner_conf.cgi', 'POST', {
      pools: [{ url: w.pool_url, user: newUser, pass: 'x' }]
    });
    store.updateWorker(w.id, { name: worker_id, pool_user: newUser, last_action: 'set_worker_id' });
    res.json({ ok: true, action: 'set_worker_id', worker_id, message: `Worker ID updated to ${worker_id}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CHANGE POOL ───────────────────────────────────────────
router.post('/set-pool', authMiddleware, requireRole('admin','manager'), async (req, res) => {
  const w = getWorker(req, res); if (!w) return;
  const { pool_url, pool_user, pool_pass = 'x', pool_url2, pool_user2, pool_url3, pool_user3 } = req.body;
  if (!pool_url || !pool_user) return res.status(400).json({ error: 'pool_url and pool_user required' });
  const pools = [
    { url: pool_url,  user: pool_user,  pass: pool_pass },
    ...(pool_url2 ? [{ url: pool_url2, user: pool_user2 || pool_user, pass: 'x' }] : []),
    ...(pool_url3 ? [{ url: pool_url3, user: pool_user3 || pool_user, pass: 'x' }] : []),
  ];
  try {
    await antminerRequest(w.ip, '/cgi-bin/set_miner_conf.cgi', 'POST', { pools });
    store.updateWorker(w.id, { pool: pool_url, pool_url, pool_user, last_action: 'set_pool' });
    res.json({ ok: true, action: 'set_pool', pool: pool_url, message: `Pool updated on ${w.name}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── LED BLINK ─────────────────────────────────────────────
router.post('/led', authMiddleware, requireRole('admin','technician'), async (req, res) => {
  const w = getWorker(req, res); if (!w) return;
  const { on = true } = req.body;
  try { await antminerRequest(w.ip, '/cgi-bin/blink.cgi', 'POST', { blink: on ? 1 : 0 }); } catch {}
  store.updateWorker(w.id, { led: on, last_action: 'led' });
  res.json({ ok: true, led: on, message: `LED ${on?'blinking':'off'} on ${w.name}` });
});

// ── RAW COMMAND ───────────────────────────────────────────
router.post('/command', authMiddleware, requireRole('admin'), async (req, res) => {
  const w = getWorker(req, res); if (!w) return;
  const { command, parameter } = req.body;
  try {
    const result = await sendCommand(w.ip, command, parameter);
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
