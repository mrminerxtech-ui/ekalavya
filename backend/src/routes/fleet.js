// ============================================================
// FLEET ROUTE — PostgreSQL-backed worker + customer storage
// ============================================================
const express = require('express');
const router  = express.Router();
const { authMiddleware } = require('../middleware/auth');
const db = require('../services/db');
const { hashPassword, isHashed } = require('../services/passwords');

// GET /api/fleet/load — load all workers + customers
router.get('/load', authMiddleware, async (req, res) => {
  const [workers, customersRaw] = await Promise.all([
    db.loadWorkers(),
    db.loadCustomers(),
  ]);
  // Never send the password hash to the browser — just tell the
  // frontend whether one is set, so the Edit form can show
  // "leave blank to keep current password" instead of implying
  // there's no password at all.
  const customers = customersRaw.map(c => {
    const { password, ...rest } = c;
    return { ...rest, has_password: !!password };
  });
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
  const { workers, customers, clearAll } = req.body;
  if (!Array.isArray(workers)) return res.status(400).json({ error: 'workers array required' });

  let processedCustomers = customers || [];
  if (processedCustomers.length > 0) {
    const existing = await db.loadCustomers();
    const existingById = new Map(existing.map(c => [c.id, c]));
    processedCustomers = processedCustomers.map(c => {
      const old = existingById.get(c.id);
      if (c.password && !isHashed(c.password)) {
        // A real new password was typed in — hash it before storing
        return { ...c, password: hashPassword(c.password) };
      }
      if (!c.password && old && old.password) {
        // No password sent this time (e.g. editing other fields, or
        // the browser never received the real hash back) — keep
        // whatever is already stored rather than wiping it out
        return { ...c, password: old.password };
      }
      return c;
    });
  }

  const [wOk, cOk] = await Promise.all([
    db.saveWorkers(workers, !!clearAll),
    db.saveCustomers(processedCustomers, !!clearAll),
  ]);

  console.log(`[FLEET] Saved ${workers.length} workers, ${processedCustomers.length} customers${clearAll ? ' (full clear)' : ' (upsert)'} → ${db.isUsingDB() ? 'PostgreSQL' : 'file'}`);
  res.json({ ok: wOk, workers: workers.length, customers: processedCustomers.length });
});

// POST /api/fleet/worker — upsert single worker (called after poll updates)
router.post('/worker', authMiddleware, async (req, res) => {
  const { worker } = req.body;
  if (!worker?.id) return res.status(400).json({ error: 'worker.id required' });
  // saveWorkers() now upserts by id internally, so a single-item array
  // correctly updates just this one record without touching any other
  await db.saveWorkers([worker]);
  res.json({ ok: true });
});

// DELETE /api/fleet/worker/:id — delete single worker
router.delete('/worker/:id', authMiddleware, async (req, res) => {
  await db.deleteWorker(req.params.id);
  res.json({ ok: true });
});

// DELETE /api/fleet/customer/:id — delete a customer AND unassign
// any miners that were pointing at them (so they don't end up
// orphaned, referencing a customer that no longer exists)
router.delete('/customer/:id', authMiddleware, async (req, res) => {
  const cid = req.params.id;
  const workers = await db.loadWorkers();
  const affected = workers.filter(w => w.cid === cid);
  if (affected.length > 0) {
    const unassigned = affected.map(w => ({ ...w, cid: '' }));
    await db.saveWorkers(unassigned); // upsert — only touches these specific machines
  }
  await db.deleteCustomer(cid);
  res.json({ ok: true, unassigned: affected.length });
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
