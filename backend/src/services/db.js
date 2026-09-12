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
// ── Efficient upsert for live poll updates ────────────────
// Unlike saveWorkers() (full bulk replace, used for manual saves/imports),
// this updates only the given workers by IP — used for the automatic
// 30-second poll cycle so we're not rewriting the entire fleet table
// every time a farm agent reports in.
async function upsertWorkersByIp(farmId, minersFoundNow) {
  if (useFallback || !pool) return upsertWorkersFallback(farmId, minersFoundNow);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const nowIps = new Set(minersFoundNow.map(m => m.ip));

    // Update or insert every miner the poll found — merge new readings
    // into the existing saved record so user-set fields (customer
    // assignment, disabled flag, farm/cid) are preserved, not overwritten
    for (const m of minersFoundNow) {
      const existing = await client.query(
        `SELECT data FROM workers WHERE data->>'ip' = $1 AND farm_id = $2`,
        [m.ip, farmId]
      );
      let merged;
      if (existing.rows.length > 0) {
        const old = existing.rows[0].data;
        merged = { ...old, ...m, id: old.id, cid: old.cid, disabled: old.disabled,
                   disabled_reason: old.disabled_reason, disabled_at: old.disabled_at,
                   farm: old.farm, farm_id: old.farm_id, status: m.status || 'online' };
        await client.query(
          `UPDATE workers SET data=$1, updated_at=NOW() WHERE data->>'ip'=$2 AND farm_id=$3`,
          [JSON.stringify(merged), m.ip, farmId]
        );
      } else {
        merged = { ...m, id: 'w-' + m.ip.replace(/\./g, '-'), farm_id: farmId, cid: '',
                   disabled: false, status: 'online', source: 'auto-poll',
                   added_at: new Date().toISOString() };
        await client.query(
          `INSERT INTO workers(id, data, farm_id) VALUES($1,$2,$3)`,
          [merged.id, JSON.stringify(merged), farmId]
        );
      }
    }

    // Mark workers under this farm that WEREN'T in this poll as offline —
    // they've either been unplugged or are unreachable right now
    const allForFarm = await client.query(`SELECT id, data FROM workers WHERE farm_id = $1`, [farmId]);
    for (const row of allForFarm.rows) {
      if (!nowIps.has(row.data.ip) && row.data.status !== 'offline' && !row.data.disabled) {
        const updated = { ...row.data, status: 'offline' };
        await client.query(`UPDATE workers SET data=$1, updated_at=NOW() WHERE id=$2`, [JSON.stringify(updated), row.id]);
      }
    }

    await client.query('COMMIT');
    return true;
  } catch(e) {
    await client.query('ROLLBACK');
    console.error('[DB] upsertWorkersByIp error:', e.message);
    return false;
  } finally { client.release(); }
}

function upsertWorkersFallback(farmId, minersFoundNow) {
  // File-based fallback — simpler in-memory merge, same semantics
  const existing = loadFallback('workers');
  const nowIps = new Set(minersFoundNow.map(m => m.ip));
  const byIp = new Map(existing.map(w => [w.ip, w]));

  minersFoundNow.forEach(m => {
    const old = byIp.get(m.ip);
    if (old && old.farm_id === farmId) {
      byIp.set(m.ip, { ...old, ...m, id: old.id, cid: old.cid, disabled: old.disabled,
        disabled_reason: old.disabled_reason, disabled_at: old.disabled_at,
        farm: old.farm, farm_id: old.farm_id, status: m.status || 'online' });
    } else if (!old) {
      byIp.set(m.ip, { ...m, id: 'w-' + m.ip.replace(/\./g, '-'), farm_id: farmId, cid: '',
        disabled: false, status: 'online', source: 'auto-poll', added_at: new Date().toISOString() });
    }
  });

  // Mark missing-from-this-poll workers (for this farm) as offline
  byIp.forEach((w, ip) => {
    if (w.farm_id === farmId && !nowIps.has(ip) && w.status !== 'offline' && !w.disabled) {
      byIp.set(ip, { ...w, status: 'offline' });
    }
  });

  return saveFallback('workers', Array.from(byIp.values()));
}

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

module.exports = { connect, saveWorkers, loadWorkers, upsertWorkersByIp, saveCustomers, loadCustomers, saveAgentConfig, loadAgentConfig, loadAllAgentConfigs, isUsingDB };
