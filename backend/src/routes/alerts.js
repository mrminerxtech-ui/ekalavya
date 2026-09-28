// ============================================================
// ALERT SETTINGS ROUTE  /api/alerts
// ------------------------------------------------------------
// The site alarm (phone call + Telegram) fires when at least N machines
// are offline at one site. N is set here from the Settings page and
// stored on the server, so it's the same on every device and survives
// redeploys. See services/alerts.js for how it's used.
// ============================================================
const express = require('express');
const router  = express.Router();
const { authMiddleware, requireRole } = require('../middleware/auth');
const alerts  = require('../services/alerts');

function staffOnly(req, res, next) {
  if ((req.user && req.user.role) === 'customer') return res.status(403).json({ ok: false, error: 'Forbidden' });
  next();
}

// GET /api/alerts/settings → { ok, alarm_at, rearm_at, default_alarm_at }
router.get('/settings', authMiddleware, staffOnly, async (req, res) => {
  await alerts.loadAlarmSetting();
  res.json({ ok: true, ...alerts.getAlarmSettings() });
});

// POST /api/alerts/settings  { alarm_at: 15 }
router.post('/settings', authMiddleware, requireRole('admin', 'manager'), async (req, res) => {
  const who = (req.user && (req.user.name || req.user.id)) || 'unknown';
  const r = await alerts.setAlarmAt((req.body || {}).alarm_at, who);
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
});

// ── Auto-restart (machines at 0 hashrate) ──────────────────────────
const autorestart = require('../services/autorestart');

// GET /api/alerts/auto-restart → { ok, enabled, minutes, max_per_day, defaults, log[], machines[] }
router.get('/auto-restart', authMiddleware, staffOnly, async (req, res) => {
  await Promise.all([autorestart.loadSettings(), autorestart.loadOverrides()]);
  res.json({ ok: true, ...autorestart.getSettings(), log: autorestart.getLog(), machines: autorestart.listOverrides() });
});

// One machine's setting, as shown on its page.
// GET /api/alerts/auto-restart/machine/:id → { ok, mode, minutes, max_per_day, default{}, active, restarts_today, zero_minutes }
router.get('/auto-restart/machine/:id', authMiddleware, staffOnly, async (req, res) => {
  const r = await autorestart.getMachine(req.params.id);
  res.status(r.ok ? 200 : 404).json(r);
});

// Set one or many machines (machine page, or bulk from the Workers list).
// POST /api/alerts/auto-restart/machines  { worker_ids:[…], mode:'default'|'off'|'on', minutes, max_per_day }
router.post('/auto-restart/machines', authMiddleware, requireRole('admin', 'manager'), async (req, res) => {
  const who = (req.user && (req.user.name || req.user.id)) || 'unknown';
  const b = req.body || {};
  const r = await autorestart.setMachines(b.worker_ids || b.worker_id, b, who);
  if (!r.ok) return res.status(400).json(r);
  res.json({ ...r, machines: autorestart.listOverrides() });
});

// POST /api/alerts/auto-restart  { enabled, minutes, max_per_day }
router.post('/auto-restart', authMiddleware, requireRole('admin', 'manager'), async (req, res) => {
  const who = (req.user && (req.user.name || req.user.id)) || 'unknown';
  const r = await autorestart.saveSettings(req.body || {}, who);
  if (!r.ok) return res.status(400).json(r);
  res.json({ ...r, log: autorestart.getLog(), machines: autorestart.listOverrides() });
});

module.exports = router;
