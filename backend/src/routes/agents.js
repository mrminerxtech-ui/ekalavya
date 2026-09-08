const express  = require('express');
const router   = express.Router();
const { authMiddleware } = require('../middleware/auth');
const agentMgr = require('../services/agentManager');

// GET all connected agents — no auth needed (read-only public info)
router.get('/', (req, res) => {
  const agents = agentMgr.getAgents();
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

// DELETE /api/agents/:farmId — remove a stale agent
router.delete('/:farmId', (req, res) => {
  const agentMgr = require('../services/agentManager');
  const removed = agentMgr.removeAgent(req.params.farmId);
  console.log(`[AGENT] Manually removed: ${req.params.farmId}`);
  res.json({ ok: true, removed });
});

module.exports = router;
