// ============================================================
// DATABASE — PostgreSQL via Railway
// Auto-creates tables on first run
// Falls back to /tmp JSON file if DATABASE_URL not set
// ============================================================
const { Pool } = require('pg');

let pool = null;
let useFallback = false;

const FALLBACK_FILE = '/tmp/ekl-fleet.json';
const fs = require('fs');

// ── Connect ───────────────────────────────────────────────
async function connect() {
  if (!process.env.DATABASE_URL) {
    console.warn('[DB] DATABASE_URL not set — using /tmp file fallback');
    useFallback = true;
    return;
  }
  try {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('railway') || process.env.DATABASE_URL.includes('amazonaws')
        ? { rejectUnauthorized: false }
        : false,
      max: 5,
      idleTimeoutMillis: 30000,
    });
    await pool.query('SELECT 1');
    console.log('[DB] ✓ PostgreSQL connected');
    await createTables();
  } catch(e) {
    console.error('[DB] Connection failed:', e.message);
    console.warn('[DB] Falling back to /tmp file storage');
    useFallback = true;
    pool = null;
  }
}

// ── Create tables ─────────────────────────────────────────
async function createTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fleet (
      id          SERIAL PRIMARY KEY,
      key         TEXT UNIQUE NOT NULL,
      data        JSONB NOT NULL DEFAULT '{}',
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS workers (
      id          TEXT PRIMARY KEY,
      data        JSONB NOT NULL,
      farm_id     TEXT,
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS customers (
      id          TEXT PRIMARY KEY,
      data        JSONB NOT NULL,
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS agent_config (
      farm_id     TEXT PRIMARY KEY,
      subnets     TEXT[],
      name        TEXT,
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('[DB] Tables ready');
}

// ── Workers CRUD ──────────────────────────────────────────
async function saveWorkers(workersList) {
  if (useFallback || !pool) return saveFallback('workers', workersList);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Delete all then re-insert (simplest for bulk replace)
    await client.query('DELETE FROM workers');
    for (const w of workersList) {
      await client.query(
        'INSERT INTO workers(id, data, farm_id) VALUES($1,$2,$3)',
        [w.id, JSON.stringify(w), w.farm_id || null]
      );
    }
    await client.query('COMMIT');
    return true;
  } catch(e) {
    await client.query('ROLLBACK');
    console.error('[DB] saveWorkers error:', e.message);
    return false;
  } finally { client.release(); }
}

async function loadWorkers() {
  if (useFallback || !pool) return loadFallback('workers');
  try {
    const r = await pool.query('SELECT data FROM workers ORDER BY updated_at ASC');
    return r.rows.map(row => row.data);
  } catch(e) {
    console.error('[DB] loadWorkers error:', e.message);
    return [];
  }
}

// ── Customers CRUD ────────────────────────────────────────
async function saveCustomers(customersList) {
  if (useFallback || !pool) return saveFallback('customers', customersList);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM customers');
    for (const c of customersList) {
      await client.query(
        'INSERT INTO customers(id, data) VALUES($1,$2)',
        [c.id, JSON.stringify(c)]
      );
    }
    await client.query('COMMIT');
    return true;
  } catch(e) {
    await client.query('ROLLBACK');
    console.error('[DB] saveCustomers error:', e.message);
    return false;
  } finally { client.release(); }
}

async function loadCustomers() {
  if (useFallback || !pool) return loadFallback('customers');
  try {
    const r = await pool.query('SELECT data FROM customers ORDER BY updated_at ASC');
    return r.rows.map(row => row.data);
  } catch(e) {
    console.error('[DB] loadCustomers error:', e.message);
    return [];
  }
}

// ── Agent subnet config ───────────────────────────────────
async function saveAgentConfig(farmId, subnets, name) {
  if (useFallback || !pool) return true;
  try {
    await pool.query(`
      INSERT INTO agent_config(farm_id, subnets, name)
      VALUES($1,$2,$3)
      ON CONFLICT(farm_id) DO UPDATE SET subnets=$2, name=$3, updated_at=NOW()
    `, [farmId, subnets, name || farmId]);
    return true;
  } catch(e) {
    console.error('[DB] saveAgentConfig error:', e.message);
    return false;
  }
}

async function loadAgentConfig(farmId) {
  if (useFallback || !pool) return null;
  try {
    const r = await pool.query('SELECT * FROM agent_config WHERE farm_id=$1', [farmId]);
    return r.rows[0] || null;
  } catch(e) { return null; }
}

async function loadAllAgentConfigs() {
  if (useFallback || !pool) return [];
  try {
    const r = await pool.query('SELECT * FROM agent_config');
    return r.rows;
  } catch(e) { return []; }
}

// ── File fallback ─────────────────────────────────────────
function saveFallback(key, data) {
  try {
    let store = {};
    if (fs.existsSync(FALLBACK_FILE)) store = JSON.parse(fs.readFileSync(FALLBACK_FILE,'utf8'));
    store[key] = data;
    store.saved = new Date().toISOString();
    fs.writeFileSync(FALLBACK_FILE, JSON.stringify(store), 'utf8');
    return true;
  } catch(e) { return false; }
}

function loadFallback(key) {
  try {
    if (!fs.existsSync(FALLBACK_FILE)) return [];
    const store = JSON.parse(fs.readFileSync(FALLBACK_FILE,'utf8'));
    return store[key] || [];
  } catch(e) { return []; }
}

function isUsingDB() { return !useFallback && pool !== null && pool !== undefined; }

module.exports = { connect, saveWorkers, loadWorkers, saveCustomers, loadCustomers, saveAgentConfig, loadAgentConfig, loadAllAgentConfigs, isUsingDB };
