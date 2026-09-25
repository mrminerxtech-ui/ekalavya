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
  const [workers, customersRaw, deleted] = await Promise.all([
    db.loadWorkers(),
    db.loadCustomers(),
    db.loadTombstones(),
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
    // What was deliberately deleted. Each device prunes these from its
    // own local copy, so a deletion made on one device actually
    // disappears everywhere instead of only where it was done.
    deleted,
    source: db.isUsingDB() ? 'postgresql' : 'file',
    count: { workers: workers.length, customers: customers.length },
  });
});

// POST /api/fleet/save — save entire fleet
router.post('/save', authMiddleware, async (req, res) => {
  const { workers: incomingWorkers, customers, clearAll } = req.body;
  if (!Array.isArray(incomingWorkers)) return res.status(400).json({ error: 'workers array required' });

  // Every device pushes its WHOLE local list here, so a device holding
  // a copy from before a deletion would otherwise push the deleted
  // record straight back and quietly undo it. Anything deliberately
  // deleted is dropped from what this save is allowed to write. (A
  // machine that was deleted but is still physically there gets its
  // deletion record cleared the moment the agent rediscovers it, so
  // this never blocks a genuine re-appearance.)
  const tombstones = await db.loadTombstones();
  const deadWorkers   = new Set(tombstones.filter(t => t.kind === 'worker').map(t => t.id));
  const deadCustomers = new Set(tombstones.filter(t => t.kind === 'customer').map(t => t.id));

  const workers = incomingWorkers.filter(w => !w || !deadWorkers.has(w.id));
  let processedCustomers = (customers || []).filter(c => !c || !deadCustomers.has(c.id));
  const blocked = (incomingWorkers.length - workers.length) + ((customers || []).length - processedCustomers.length);
  if (blocked > 0) {
    console.log(`[FLEET] Ignored ${blocked} deleted record(s) pushed back by an out-of-date device`);
  }
  if (processedCustomers.length > 0) {
    const existing = await db.loadCustomers();
    const existingById = new Map(existing.map(c => [c.id, c]));
    const orphaned = [];
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
      // No password here, and none on record either — but the browser
      // believes this customer HAS one (has_password came back true on
      // its last load). The password hash is never sent to the browser,
      // so a device can't supply it: this means the stored record was
      // lost since that device last synced. Recreating the customer
      // without a password would leave a portal account that silently
      // rejects every login, and hide the fact that anything was lost.
      // The record is kept, portal access is switched off, and it's
      // said out loud instead.
      if (!c.password && !old && c.has_password) {
        orphaned.push(c.name || c.id);
        return { ...c, portal: false, has_password: false };
      }
      return c;
    });
    if (orphaned.length > 0) {
      console.warn(`[FLEET] ⚠ ${orphaned.length} customer(s) restored from a device's local copy WITHOUT their password: ${orphaned.join(', ')}`);
      console.warn('[FLEET]   Their stored record was lost (see the [DB] warnings at startup — most likely the database was unreachable and data went to the ephemeral fallback file).');
      console.warn('[FLEET]   Portal access is off for them until an admin sets a new password in Customers → Edit.');
    }
  }

  // A "Clear All" wipes the server's tables, but every other device
  // still holds its own copy and would push the whole fleet back on its
  // next save. Record what's being wiped so the clear actually sticks
  // everywhere. (Machines still physically present get rediscovered by
  // their agent, which clears their record again — as it should.)
  if (clearAll) {
    const [oldWorkers, oldCustomers] = await Promise.all([db.loadWorkers(), db.loadCustomers()]);
    await Promise.all([]
      .concat(oldWorkers.map(w => db.addTombstone('worker', w.id)))
      .concat(oldCustomers.map(c => db.addTombstone('customer', c.id))));
    console.log(`[FLEET] Clear All — recorded ${oldWorkers.length} machine(s) and ${oldCustomers.length} customer(s) as deleted`);
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

// POST /api/fleet/worker/merge — fold a duplicate machine record into
// its real one. Comes up after an IP change the poller couldn't match
// back to the existing record (see the long comment on db.mergeWorkers
// for why that happens) — most often a batch of machines rebooting at
// once after a power outage. Staff only: a customer has no business
// merging fleet records.
router.post('/worker/merge', authMiddleware, async (req, res) => {
  if (req.user && req.user.role === 'customer') return res.status(403).json({ ok: false, error: 'Forbidden' });
  const { keep_id, discard_id } = req.body || {};
  const result = await db.mergeWorkers(keep_id, discard_id);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

// POST /api/fleet/dedupe/run — run the automatic duplicate merge now
// instead of waiting for its 10-minute timer. Returns what was merged and
// what was deliberately left alone (with the reason), so it doubles as a
// way to see why a pair you expected to merge didn't. Staff only.
router.post('/dedupe/run', authMiddleware, async (req, res) => {
  if (req.user && req.user.role === 'customer') return res.status(403).json({ ok: false, error: 'Forbidden' });
  const summary = await require('../services/dedupe').runOnce();
  res.json({ ok: !summary.error, ...summary });
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
