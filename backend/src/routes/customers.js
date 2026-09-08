// ============================================================
// CUSTOMER ROUTES  /api/customers
// ============================================================
const express = require('express');
const jwt     = require('jsonwebtoken');
const router  = express.Router();
const { authMiddleware, requireRole } = require('../middleware/auth');
const ca      = require('../services/customerAccess');
const store   = require('../services/store');

const JWT_SECRET  = process.env.JWT_SECRET  || 'mmx-dev-secret';
const JWT_EXPIRES = process.env.JWT_EXPIRES_IN || '7d';

// ── Customer login ─────────────────────────────────────────
// POST /api/customers/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const cust = await ca.authenticateCustomer(email, password);
  if (!cust) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign(
    { id: cust.id, email: cust.email, name: cust.name, role: 'customer' },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );

  res.json({ token, customer: ca.safeCustomer(cust) });
});

// ── Admin: list all customers ──────────────────────────────
// GET /api/customers
router.get('/', authMiddleware, requireRole('admin', 'manager'), (req, res) => {
  const custs   = ca.getCustomers();
  const workers = store.getWorkers();
  const result  = custs.map(c => ({
    ...c,
    machines:        c.assigned_workers.length,
    machines_online: workers.filter(w => c.assigned_workers.includes(w.id) && w.status === 'online').length,
  }));
  res.json(result);
});

// ── Admin: create customer ─────────────────────────────────
// POST /api/customers
router.post('/', authMiddleware, requireRole('admin'), (req, res) => {
  try {
    const cust = ca.createCustomer(req.body);
    const temp = cust._temp_password;
    res.status(201).json({ ...ca.safeCustomer(cust), temp_password: temp });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Admin: update customer ─────────────────────────────────
// PUT /api/customers/:id
router.put('/:id', authMiddleware, requireRole('admin'), (req, res) => {
  const c = ca.updateCustomer(req.params.id, req.body);
  if (!c) return res.status(404).json({ error: 'Customer not found' });
  res.json(ca.safeCustomer(c));
});

// ── Admin: delete customer ─────────────────────────────────
// DELETE /api/customers/:id
router.delete('/:id', authMiddleware, requireRole('admin'), (req, res) => {
  ca.deleteCustomer(req.params.id);
  res.json({ ok: true });
});

// ── Admin: assign workers to customer ─────────────────────
// POST /api/customers/:id/assign
router.post('/:id/assign', authMiddleware, requireRole('admin', 'manager'), (req, res) => {
  const { worker_ids } = req.body;
  if (!Array.isArray(worker_ids)) return res.status(400).json({ error: 'worker_ids[] required' });
  try {
    const assigned = ca.assignWorkersBulk(req.params.id, worker_ids);
    res.json({ ok: true, assigned });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/customers/:id/unassign
router.post('/:id/unassign', authMiddleware, requireRole('admin', 'manager'), (req, res) => {
  const { worker_id } = req.body;
  try {
    const assigned = ca.unassignWorker(req.params.id, worker_id);
    res.json({ ok: true, assigned });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Admin: get billing summary for a customer ──────────────
// GET /api/customers/:id/billing
router.get('/:id/billing', authMiddleware, requireRole('admin', 'manager'), (req, res) => {
  const workers = store.getWorkers();
  const prices  = store.getPricesCache().data || [];
  const bill    = ca.calcBill(req.params.id, workers, prices);
  if (!bill) return res.status(404).json({ error: 'Customer not found' });
  res.json(bill);
});

// ════════════════════════════════════════════════════════════
// CUSTOMER PORTAL ROUTES (authenticated as customer role)
// ════════════════════════════════════════════════════════════

// Customer auth middleware
function customerAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(header.split(' ')[1], JWT_SECRET);
    if (req.user.role !== 'customer' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Customer access required' });
    }
    next();
  } catch { return res.status(401).json({ error: 'Invalid token' }); }
}

// GET /api/customers/portal/me — customer's own profile
router.get('/portal/me', customerAuth, (req, res) => {
  const c = ca.getCustomer(req.user.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json(ca.safeCustomer(c));
});

// GET /api/customers/portal/workers — customer's miners only
router.get('/portal/workers', customerAuth, (req, res) => {
  // Admin sees everything; customer sees only their miners
  const workerIds = req.user.role === 'admin'
    ? store.getWorkers().map(w => w.id)
    : ca.getCustomerWorkerIds(req.user.id);

  const myWorkers = store.getWorkers()
    .filter(w => workerIds.includes(w.id))
    .map(w => ({
      // Expose safe fields only — no other customers' data
      id:        w.id,
      name:      w.name,
      model:     w.model,
      ip:        w.ip,          // so they can see their machine
      status:    w.status,
      hashrate:  w.hashrate,
      temperature: w.temperature,
      fan_speed: w.fan_speed,
      power:     w.power,
      pool:      w.pool,
      uptime:    w.uptime,
      last_seen: w.last_seen,
      farm_id:   w.farm_id,
      farm_name: w.farm_name,
    }));

  res.json(myWorkers);
});

// GET /api/customers/portal/stats — customer's fleet summary
router.get('/portal/stats', customerAuth, (req, res) => {
  const workerIds = ca.getCustomerWorkerIds(req.user.id);
  const workers   = store.getWorkers().filter(w => workerIds.includes(w.id));
  const online    = workers.filter(w => w.status === 'online');

  res.json({
    total:           workers.length,
    online:          online.length,
    offline:         workers.length - online.length,
    total_hashrate:  +online.reduce((a, w) => a + (w.hashrate || 0), 0).toFixed(2),
    avg_temperature: online.length
      ? +(online.reduce((a, w) => a + (w.temperature || 0), 0) / online.length).toFixed(1)
      : 0,
    total_power:     online.reduce((a, w) => a + (w.power || 0), 0),
  });
});

// GET /api/customers/portal/billing — customer's own bill
router.get('/portal/billing', customerAuth, (req, res) => {
  const workers = store.getWorkers();
  const prices  = store.getPricesCache().data || [];
  const bill    = ca.calcBill(req.user.id, workers, prices);
  if (!bill) return res.status(404).json({ error: 'Not found' });
  res.json(bill);
});

module.exports = router;
