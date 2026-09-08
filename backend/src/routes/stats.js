// ============================================================
// STATS ROUTES  /api/stats
// ============================================================
const express = require('express');
const router  = express.Router();
const { authMiddleware } = require('../middleware/auth');
const store = require('../services/store');
const { getConnectedCount } = require('../websocket');

// GET /api/stats/fleet — overall fleet summary
router.get('/fleet', authMiddleware, (req, res) => {
  res.json(store.getFleetSummary());
});

// GET /api/stats/alerts — recent alerts
router.get('/alerts', authMiddleware, (req, res) => {
  res.json(store.getAlerts());
});

// GET /api/stats/ws-clients — how many browsers are connected
router.get('/ws-clients', authMiddleware, (req, res) => {
  res.json({ connected: getConnectedCount() });
});

module.exports = router;
