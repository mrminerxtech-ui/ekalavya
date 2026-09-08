// ============================================================
// CUSTOMER ACCESS SERVICE
// Maps customers → their assigned miners
// Enforces read-only access on customer API calls
// ============================================================
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');

// ── Customer store (replace with DB in production) ───────────
let customers = [
  {
    id:           'cust-001',
    name:         'Ahmad Al-Farsi',
    email:        'ahmad@example.com',
    passwordHash: bcrypt.hashSync('ahmad123', 10),
    phone:        '+966 50 000 0001',
    country:      'Saudi Arabia',
    flag:         '🇸🇦',
    plan:         'Pro',
    rate_per_machine: 350,    // $/month per machine
    assigned_workers: [],     // filled by admin
    created_at:   new Date().toISOString(),
    active:       true,
    notes:        '',
  },
  {
    id:           'cust-002',
    name:         'Sarah Chen',
    email:        'sarah@example.com',
    passwordHash: bcrypt.hashSync('sarah123', 10),
    phone:        '+86 138 0000 0001',
    country:      'China',
    flag:         '🇨🇳',
    plan:         'Enterprise',
    rate_per_machine: 320,
    assigned_workers: [],
    created_at:   new Date().toISOString(),
    active:       true,
    notes:        '',
  },
];

// ── CRUD ─────────────────────────────────────────────────────
function getCustomers()       { return customers.map(safeCustomer); }
function getCustomer(id)      { return customers.find(c => c.id === id); }
function getCustomerByEmail(email) { return customers.find(c => c.email.toLowerCase() === email.toLowerCase()); }

function createCustomer(data) {
  const pw   = data.password || Math.random().toString(36).slice(2, 10);
  const cust = {
    id:               uuidv4(),
    name:             data.name,
    email:            data.email,
    passwordHash:     bcrypt.hashSync(pw, 10),
    phone:            data.phone    || '',
    country:          data.country  || '',
    flag:             data.flag     || '🌍',
    plan:             data.plan     || 'Basic',
    rate_per_machine: data.rate_per_machine || 300,
    assigned_workers: [],
    created_at:       new Date().toISOString(),
    active:           true,
    notes:            data.notes || '',
    _temp_password:   pw,  // returned once on creation
  };
  customers.push(cust);
  return cust;
}

function updateCustomer(id, data) {
  const idx = customers.findIndex(c => c.id === id);
  if (idx < 0) return null;
  if (data.password) {
    data.passwordHash = bcrypt.hashSync(data.password, 10);
    delete data.password;
  }
  customers[idx] = { ...customers[idx], ...data };
  return customers[idx];
}

function deleteCustomer(id) {
  customers = customers.filter(c => c.id !== id);
}

// ── Miner Assignment ──────────────────────────────────────────
function assignWorker(customerId, workerId) {
  const c = customers.find(c => c.id === customerId);
  if (!c) throw new Error('Customer not found');
  if (!c.assigned_workers.includes(workerId)) {
    c.assigned_workers.push(workerId);
  }
  return c.assigned_workers;
}

function unassignWorker(customerId, workerId) {
  const c = customers.find(c => c.id === customerId);
  if (!c) throw new Error('Customer not found');
  c.assigned_workers = c.assigned_workers.filter(id => id !== workerId);
  return c.assigned_workers;
}

function assignWorkersBulk(customerId, workerIds) {
  const c = customers.find(c => c.id === customerId);
  if (!c) throw new Error('Customer not found');
  c.assigned_workers = [...new Set([...c.assigned_workers, ...workerIds])];
  return c.assigned_workers;
}

function getCustomerWorkerIds(customerId) {
  const c = customers.find(c => c.id === customerId);
  return c?.assigned_workers || [];
}

// Which customer owns a given worker?
function getWorkerOwner(workerId) {
  return customers.find(c => c.assigned_workers.includes(workerId));
}

// ── Billing ───────────────────────────────────────────────────
function calcBill(customerId, workers, prices) {
  const c = getCustomer(customerId);
  if (!c) return null;

  const myWorkers  = workers.filter(w => c.assigned_workers.includes(w.id));
  const online     = myWorkers.filter(w => w.status === 'online');
  const btcPrice   = prices?.find(p => p.symbol === 'BTC')?.price_usd || 67000;

  const hosting_fee  = myWorkers.length * c.rate_per_machine;
  const gross_mining = online.reduce((a, w) => {
    const daily_btc = (w.hashrate || 0) / 1e6 * 0.0000058 * 30;  // rough monthly
    return a + daily_btc * btcPrice;
  }, 0);

  return {
    customer_id:     c.id,
    customer_name:   c.name,
    machines:        myWorkers.length,
    machines_online: online.length,
    hosting_fee:     +hosting_fee.toFixed(2),
    gross_mining:    +gross_mining.toFixed(2),
    net_profit:      +(gross_mining - hosting_fee).toFixed(2),
    plan:            c.plan,
    rate_per_machine: c.rate_per_machine,
    period:          new Date().toISOString().slice(0, 7),  // YYYY-MM
  };
}

// ── Auth ──────────────────────────────────────────────────────
async function authenticateCustomer(email, password) {
  const c = getCustomerByEmail(email);
  if (!c || !c.active) return null;
  const valid = await bcrypt.compare(password, c.passwordHash);
  return valid ? c : null;
}

// Strip sensitive fields for API responses
function safeCustomer(c) {
  const { passwordHash, _temp_password, ...safe } = c;
  return safe;
}

module.exports = {
  getCustomers, getCustomer, getCustomerByEmail, createCustomer, updateCustomer, deleteCustomer,
  assignWorker, unassignWorker, assignWorkersBulk, getCustomerWorkerIds, getWorkerOwner,
  calcBill, authenticateCustomer, safeCustomer,
};
