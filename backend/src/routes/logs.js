const express  = require('express');
const router   = express.Router();
const { authMiddleware } = require('../middleware/auth');
const agentMgr = require('../services/agentManager');

// Pending log requests
const pending = new Map();

// POST /api/logs/fetch — request log from miner via agent
router.post('/fetch', authMiddleware, (req, res) => {
  const { ip, farm_id } = req.body;
  if (!ip || !farm_id) return res.status(400).json({ error: 'ip and farm_id required' });

  const request_id = 'log-' + Date.now();
  
  // Set up pending with timeout
  let resolved = false;
  const timeout = setTimeout(() => {
    if (!resolved) {
      resolved = true;
      pending.delete(request_id);
      res.status(504).json({ error: 'Timeout: agent did not respond in 15s' });
    }
  }, 15000);

  pending.set(request_id, (log) => {
    if (!resolved) {
      resolved = true;
      clearTimeout(timeout);
      pending.delete(request_id);
      res.json({ ok: true, ip, log });
    }
  });

  const sent = agentMgr.sendToAgent(farm_id, { type: 'fetch_log', ip, request_id });
  if (!sent) {
    clearTimeout(timeout);
    pending.delete(request_id);
    return res.status(404).json({ error: 'Agent not connected' });
  }
});

// POST /api/logs/result — agent posts log back (no auth)
router.post('/result', (req, res) => {
  const { request_id, log, ip } = req.body;
  const handler = pending.get(request_id);
  if (handler) handler(log);
  res.json({ ok: true });
});

module.exports = router;
