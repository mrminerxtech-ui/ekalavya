// ============================================================
// EARNINGS ROUTE  /api/earnings
// ------------------------------------------------------------
// Reads the running totals that services/earnings.js accrues
// every 10 minutes. This route only READS — nothing here can
// create earnings, so a page refresh can never inflate a total.
// ============================================================
const express = require('express');
const router  = express.Router();
const { authMiddleware } = require('../middleware/auth');
const db = require('../services/db');
const { SLOT_MINUTES } = require('../services/earnings');

// A customer may only read their own earnings. Without this check
// any logged-in customer could read every other customer's revenue
// just by changing the id in the URL.
function canRead(req, customerId) {
  const u = req.user || {};
  if (u.role === 'admin' || u.role === 'team') return true;
  return String(u.id) === String(customerId);
}

// GET /api/earnings/summary/:customerId
router.get('/summary/:customerId', authMiddleware, async (req, res) => {
  const { customerId } = req.params;
  if (!canRead(req, customerId)) return res.status(403).json({ ok: false, error: 'Forbidden' });
  try {
    const s = await db.getEarningsSummary(customerId);
    res.json({ ok: true, slot_minutes: SLOT_MINUTES, ...s });
  } catch (e) {
    console.error('[EARNINGS] summary failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/earnings/history/:customerId?days=30 — day-by-day rows,
// so the portal can show what was earned on each individual day.
router.get('/history/:customerId', authMiddleware, async (req, res) => {
  const { customerId } = req.params;
  if (!canRead(req, customerId)) return res.status(403).json({ ok: false, error: 'Forbidden' });
  const limit = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
  try {
    const rows = await db.getEarningsHistory(customerId, limit);
    res.json({ ok: true, days: rows });
  } catch (e) {
    console.error('[EARNINGS] history failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
