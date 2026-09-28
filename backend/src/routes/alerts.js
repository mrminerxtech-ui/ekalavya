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

module.exports = router;
