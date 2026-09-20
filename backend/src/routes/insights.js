// ============================================================
// INSIGHTS ROUTE  /api/insights
// ------------------------------------------------------------
// Read-only views over the metric history: which machines are
// underperforming, what each one's uptime has been, and a single
// machine's history for charting.
// ============================================================
const express = require('express');
const router  = express.Router();
const { authMiddleware } = require('../middleware/auth');
const db = require('../services/db');
const insights = require('../services/insights');

// These report on the whole fleet, so they're staff-only. A customer
// asking for them would otherwise see every other customer's machines.
function staffOnly(req, res, next) {
  const role = (req.user && req.user.role) || '';
  if (role === 'customer') return res.status(403).json({ ok: false, error: 'Forbidden' });
  next();
}

// GET /api/insights/underperformers?hours=6&farm=Farm_4&threshold=15
router.get('/underperformers', authMiddleware, staffOnly, async (req, res) => {
  try {
    const result = await insights.findUnderperformers({
      hours:        req.query.hours,
      farmId:       req.query.farm || null,
      thresholdPct: req.query.threshold,
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[INSIGHTS] underperformers failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/insights/uptime?days=7&farm=Farm_4
router.get('/uptime', authMiddleware, staffOnly, async (req, res) => {
  try {
    const rows = await db.getUptimeReport(req.query.days, req.query.farm || null);
    const workers = await db.loadWorkers().catch(() => []);
    const byId = new Map((workers || []).map(w => [w.id, w]));
    const enriched = rows.map(r => {
      const w = byId.get(r.worker_id) || {};
      return {
        ...r,
        name: w.name || w.ip || r.worker_id,
        ip:   w.ip || null,
        uptime_pct: r.uptime_pct != null ? Math.round(Number(r.uptime_pct) * 10) / 10 : null,
      };
    }).sort((a, b) => (a.uptime_pct ?? 101) - (b.uptime_pct ?? 101)); // worst first
    res.json({ ok: true, days: Number(req.query.days) || 7, count: enriched.length, workers: enriched });
  } catch (e) {
    console.error('[INSIGHTS] uptime failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/insights/history/:workerId?hours=24
// A customer may read the history of a machine assigned to them.
router.get('/history/:workerId', authMiddleware, async (req, res) => {
  const { workerId } = req.params;
  try {
    if (req.user && req.user.role === 'customer') {
      const workers = await db.loadWorkers().catch(() => []);
      const w = (workers || []).find(x => x && x.id === workerId);
      const hasId = v => v !== null && v !== undefined && String(v).trim() !== '';
      if (!w || !hasId(w.cid) || !hasId(req.user.id) || String(w.cid) !== String(req.user.id)) {
        return res.status(403).json({ ok: false, error: 'Forbidden' });
      }
    }
    const rows = await db.getWorkerHistory(workerId, req.query.hours);
    res.json({ ok: true, worker_id: workerId, points: rows.length, history: rows });
  } catch (e) {
    console.error('[INSIGHTS] history failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
