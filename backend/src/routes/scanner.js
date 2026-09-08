const express  = require('express');
const router   = express.Router();
const { authMiddleware } = require('../middleware/auth');
const agentMgr = require('../services/agentManager');

const sessions = new Map();

// POST /api/scanner/start — accepts subnets[] or single subnet
router.post('/start', authMiddleware, (req, res) => {
  const { farm_id, subnets, subnet, ports, timeout } = req.body;
  if (!farm_id) return res.status(400).json({ error: 'farm_id required' });

  const agent = agentMgr.getAgent(farm_id);
  if (!agent) {
    console.warn(`[SCANNER] Agent "${farm_id}" not found. Connected agents: ${[...require('../services/agentManager').getAgents().map(a=>a.farm_id+'/'+a.farm_name)].join(', ') || 'none'}`);
    return res.status(404).json({ error: `Agent "${farm_id}" not connected. Check FARM_ID in agent .env matches exactly.` });
  }

  // Normalise: accept both subnets[] and legacy subnet string
  const subnetList = Array.isArray(subnets) && subnets.length > 0
    ? subnets
    : [subnet || agent.subnet || '192.168.1.0/24'];

  const session_id = 'scan-' + Date.now();
  sessions.set(session_id, {
    farm_id, session_id,
    subnets:  subnetList,
    started:  new Date().toISOString(),
    found:    [],
    seenIPs:  new Set(),
    scanned:  0,
    total:    0,
    progress: 0,
    done:     false,
    current_subnet: subnetList[0],
    subnets_done: 0,
  });

  // Send all subnets in one message — agent loops through them
  const sent = agentMgr.sendToAgent(farm_id, {
    type:     'scan',
    session_id,
    subnets:  subnetList,
    subnet:   subnetList[0],   // legacy compat
    ports:    ports   || [4028, 80, 8080],
    timeout:  timeout || 2000,
  });

  if (!sent) return res.status(500).json({ error: 'Failed to send scan to agent' });

  console.log(`[SCANNER] ▶ ${farm_id} (${agent.farm_name||farm_id}) → ${subnetList.join(', ')} | ${session_id}`);
  res.json({ ok: true, session_id, subnets: subnetList });
});

// GET /api/scanner/results/:sessionId
router.get('/results/:sessionId', authMiddleware, (req, res) => {
  const s = sessions.get(req.params.sessionId);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  res.json({
    ok: true, session_id: s.session_id,
    found: s.found, scanned: s.scanned, total: s.total,
    progress: s.progress, done: s.done,
    subnets: s.subnets, current_subnet: s.current_subnet,
  });
});

// POST /api/scanner/result — agent posts results (no auth)
router.post('/result', (req, res) => {
  const { session_id, found, scanned, total, progress, done, current_subnet } = req.body;
  const s = sessions.get(session_id);
  if (s) {
    if (found?.length > 0) {
      found.forEach(miner => {
        if (!s.seenIPs.has(miner.ip)) {
          s.seenIPs.add(miner.ip);
          s.found.push(miner);
          console.log(`[SCANNER] Found: ${miner.ip} — ${miner.brand||''} ${miner.model||''} | ${miner.hr_display||'—'}`);
        }
      });
    }
    if (scanned        !== undefined) s.scanned        = scanned;
    if (total          !== undefined) s.total          = total;
    if (progress       !== undefined) s.progress       = progress;
    if (current_subnet !== undefined) s.current_subnet = current_subnet;
    if (done) s.done = true;
  }
  res.json({ ok: true });
});

setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  sessions.forEach((s, id) => {
    if (new Date(s.started).getTime() < cutoff) sessions.delete(id);
  });
}, 5 * 60 * 1000);

module.exports = router;
