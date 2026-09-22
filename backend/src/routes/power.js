// ============================================================
// POWER ROUTE — hand-entered wattage per miner MODEL
// ------------------------------------------------------------
// Many miners never report their own power draw, and not every model
// is in the built-in spec table, so those machines can't be counted in
// a site's power total at all.
//
// The figure is entered ONCE against a model and stored centrally, so
// every machine of that model picks it up — at every site, through
// every agent, on every device. That is the whole point of keeping it
// here rather than on the machine record: a fleet has dozens of
// identical units and nobody should type the same number dozens of
// times, nor have the answer differ between a laptop and a phone.
// ============================================================
const express = require('express');
const router  = express.Router();
const { authMiddleware, requireRole } = require('../middleware/auth');
const db = require('../services/db');

// A single ASIC outside this range is not a real reading — it's a
// typo (3.5 instead of 3500) or a units mix-up (kW typed as W). Worth
// catching here, because one bad entry silently multiplies across
// every machine of that model at every site.
const MIN_WATTS = 50;
const MAX_WATTS = 25000;

// GET /api/power/models — every hand-entered model wattage
router.get('/models', authMiddleware, async (req, res) => {
  const models = await db.loadModelPower();
  res.json({ ok: true, models });
});

// POST /api/power/models — set (or correct) one model's wattage
//
// `force` (default false): a miner's own live reading normally wins
// over this entry — it's a measurement, this is someone's figure.
// Setting force means the entered number was checked against reality
// (a clamp meter, the site's PDU) and should be trusted OVER what that
// model's firmware reports, because the firmware reading itself is
// known to be wrong rather than simply absent. That's the case at a
// hydro site where a model reports a plausible-looking wattage that
// doesn't match what it's actually pulling.
router.post('/models', authMiddleware, requireRole('admin', 'manager', 'technician'), async (req, res) => {
  const { model, watts, force } = req.body || {};
  if (!model || !String(model).trim()) {
    return res.status(400).json({ error: 'model is required' });
  }
  const w = Number(watts);
  if (!isFinite(w) || w < MIN_WATTS || w > MAX_WATTS) {
    return res.status(400).json({
      error: `watts must be a number between ${MIN_WATTS} and ${MAX_WATTS} — got "${watts}". ` +
             `Enter the machine's draw in watts (an Antminer L9 is about 3570), not kilowatts.`,
    });
  }
  const label = String(model).trim();
  const ok = await db.saveModelPower(label, w, label, req.user?.name || req.user?.id || 'unknown', !!force);
  if (!ok) return res.status(500).json({ error: 'Could not save that model power' });

  console.log(`[POWER] ${label} set to ${Math.round(w)}W${force ? ' (overriding the miner\'s own reading)' : ''} by ${req.user?.name || req.user?.id}`);
  const models = await db.loadModelPower();
  res.json({ ok: true, models });
});

// DELETE /api/power/models/:key — drop a hand-entered figure, so the
// model falls back to the built-in spec table (or to "not counted")
router.delete('/models/:key', authMiddleware, requireRole('admin', 'manager', 'technician'), async (req, res) => {
  const ok = await db.deleteModelPower(req.params.key);
  if (!ok) return res.status(500).json({ error: 'Could not remove that model power' });
  console.log(`[POWER] ${req.params.key} cleared by ${req.user?.name || req.user?.id}`);
  const models = await db.loadModelPower();
  res.json({ ok: true, models });
});

module.exports = router;
