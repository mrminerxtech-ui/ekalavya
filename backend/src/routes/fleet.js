// ============================================================
// FLEET ROUTE — PostgreSQL-backed worker + customer storage
// ============================================================
const express = require('express');
const router  = express.Router();
const { authMiddleware } = require('../middleware/auth');
const db = require('../services/db');

// GET /api/fleet/load — load all workers + customers
router.get('/load', authMiddleware, async (req, res) => {
  const [workers, customers] = await Promise.all([
    db.loadWorkers(),
    db.loadCustomers(),
  ]);
  res.json({
    ok: true,
    workers,
    customers,
    source: db.isUsingDB() ? 'postgresql' : 'file',
    count: { workers: workers.length, customers: customers.length },
  });
});

// POST /api/fleet/save — save entire fleet
router.post('/save', authMiddleware, async (req, res) => {
  const { workers, customers } = req.body;
  if (!Array.isArray(workers)) return res.status(400).json({ error: 'workers array required' });

  const [wOk, cOk] = await Promise.all([
    db.saveWorkers(workers),
    db.saveCustomers(customers || []),
  ]);

  console.log(`[FLEET] Saved ${workers.length} workers, ${customers?.length || 0} customers → ${db.isUsingDB() ? 'PostgreSQL' : 'file'}`);
  res.json({ ok: wOk, workers: workers.length, customers: customers?.length || 0 });
});

// POST /api/fleet/worker — upsert single worker (called after poll updates)
router.post('/worker', authMiddleware, async (req, res) => {
  const { worker } = req.body;
  if (!worker?.id) return res.status(400).json({ error: 'worker.id required' });
  const existing = await db.loadWorkers();
  const updated  = existing.filter(w => w.id !== worker.id);
  updated.push(worker);
  await db.saveWorkers(updated);
  res.json({ ok: true });
});

// DELETE /api/fleet/worker/:id — delete single worker
router.delete('/worker/:id', authMiddleware, async (req, res) => {
  const existing = await db.loadWorkers();
  await db.saveWorkers(existing.filter(w => w.id !== req.params.id));
  res.json({ ok: true });
});

// GET /api/fleet/status
router.get('/status', authMiddleware, async (req, res) => {
  const [workers, customers] = await Promise.all([db.loadWorkers(), db.loadCustomers()]);
  res.json({
    ok: true,
    storage: db.isUsingDB() ? 'postgresql' : 'file',
    workers: workers.length,
    customers: customers.length,
  });
});

// POST /api/fleet/agent-config — save per-agent subnet config
router.post('/agent-config', authMiddleware, async (req, res) => {
  const { farm_id, subnets, name } = req.body;
  if (!farm_id) return res.status(400).json({ error: 'farm_id required' });
  await db.saveAgentConfig(farm_id, subnets || [], name);
  res.json({ ok: true });
});

// GET /api/fleet/agent-configs — load all agent configs
router.get('/agent-configs', authMiddleware, async (req, res) => {
  const configs = await db.loadAllAgentConfigs();
  res.json({ ok: true, configs });
});

module.exports = router;
