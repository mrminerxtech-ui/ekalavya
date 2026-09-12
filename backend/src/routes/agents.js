const express  = require('express');
const router   = express.Router();
const { authMiddleware } = require('../middleware/auth');
const agentMgr = require('../services/agentManager');

// GET all connected agents — no auth needed (read-only public info)
router.get('/', (req, res) => {
  const agents = agentMgr.getAgents().map(a => {
    const checkin = checkinStore[a.farm_id];
    return checkin ? {
      ...a,
      agent_version:    checkin.version,
      updater_uptime:   checkin.updater_uptime,
      last_update_at:   checkin.last_update_at,
      crash_count_5m:   checkin.crash_count_5m,
      node_version:     checkin.node_version,
      last_checkin_at:  checkin.received_at,
    } : a;
  });
  console.log(`[API] /agents called — returning ${agents.length} agents`);
  res.json({ ok: true, count: agents.length, agents });
});

// GET single agent
router.get('/:farmId', (req, res) => {
  const agent = agentMgr.getAgent(req.params.farmId);
  if (!agent) return res.status(404).json({ error: 'Agent not found', available: agentMgr.getAgents().map(a=>a.farm_id) });
  res.json({ ok: true, agent });
});

// POST scan — needs auth
router.post('/:farmId/scan', authMiddleware, (req, res) => {
  const { subnet, ports, timeout } = req.body;
  const sent = agentMgr.sendToAgent(req.params.farmId, { type:'scan', subnet, ports, timeout });
  if (!sent) return res.status(404).json({ error: 'Agent not connected' });
  res.json({ ok: true, message: 'Scan triggered' });
});

// POST command — needs auth
router.post('/:farmId/command', authMiddleware, (req, res) => {
  const sent = agentMgr.sendToAgent(req.params.farmId, { type:'command', ...req.body });
  if (!sent) return res.status(404).json({ error: 'Agent not connected' });
  res.json({ ok: true, message: 'Command sent' });
});

// ── Manifest-driven check-in — separate from the WebSocket heartbeat.
// Reports version, uptime, and crash history so the app can show
// "this PC's supervisor is alive" even during an agent restart. ──────
const checkinStore = {}; // farm_id → last check-in payload

router.post('/checkin', (req, res) => {
  const { farm_id } = req.body;
  if (!farm_id) return res.status(400).json({ error: 'farm_id required' });
  checkinStore[farm_id] = { ...req.body, received_at: new Date().toISOString() };
  res.json({ ok: true });
});

router.get('/checkin/:farmId', (req, res) => {
  const c = checkinStore[req.params.farmId];
  if (!c) return res.status(404).json({ error: 'No check-in received yet for this farm' });
  res.json({ ok: true, checkin: c });
});

router.get('/checkins/all', (req, res) => {
  res.json({ ok: true, checkins: checkinStore });
});

// DELETE /api/agents/:farmId — remove a stale agent
router.delete('/:farmId', (req, res) => {
  const agentMgr = require('../services/agentManager');
  const removed = agentMgr.removeAgent(req.params.farmId);
  console.log(`[AGENT] Manually removed: ${req.params.farmId}`);
  res.json({ ok: true, removed });
});

module.exports = router;
