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
// A worker's id is its PERMANENT identity — it's what customer
// assignments and every other reference point at, so it must never
// change for the life of the machine. Deriving it from the IP address
// (as this used to) breaks completely on DHCP: the moment a lease
// renews or a machine is moved between sites, it gets a new id, is
// treated as a brand new machine with no customer attached, and the
// old record is orphaned. MAC and serial are burned into the hardware
// and never change, so they make a correct identity; IP is only a
// last resort for machines that expose neither.
function stableWorkerId(m) {
  if (m.mac)    return 'w-mac-' + String(m.mac).toUpperCase().replace(/[^0-9A-F]/g, '');
  if (m.serial) return 'w-sn-'  + String(m.serial).replace(/[^0-9A-Za-z]/g, '');
  return 'w-ip-' + String(m.ip).replace(/\./g, '-');
}

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
      // A machine can be PHYSICALLY MOVED between farms for operational
      // reasons — its IP changes, but its MAC and Serial never do.
      // Check the WHOLE fleet (not just this farm) for a hardware match
      // before assuming this IP represents a brand-new machine. This is
      // what stops a moved miner from showing up as a duplicate under a
      // second record at its new address.
      let existing = null;
      if (m.mac) {
        const byMac = await client.query(`SELECT id, data FROM workers WHERE data->>'mac' = $1`, [m.mac]);
        if (byMac.rows.length > 0) existing = byMac.rows[0];
      }
      if (!existing && m.serial) {
        const bySerial = await client.query(`SELECT id, data FROM workers WHERE data->>'serial' = $1`, [m.serial]);
        if (bySerial.rows.length > 0) existing = bySerial.rows[0];
      }
      if (!existing) {
        const byIp = await client.query(`SELECT id, data FROM workers WHERE data->>'ip' = $1 AND farm_id = $2`, [m.ip, farmId]);
        if (byIp.rows.length > 0) existing = byIp.rows[0];
      }

      if (existing) {
        const old = existing.data;
        const moved = old.ip !== m.ip || old.farm_id !== farmId;
        const merged = { ...old, ...m, id: old.id, cid: old.cid, disabled: old.disabled,
                   disabled_reason: old.disabled_reason, disabled_at: old.disabled_at,
                   // If it moved, adopt the NEW farm/ip — that's genuinely
                   // where it is now. Otherwise keep exactly as before.
                   farm: moved ? (m.farm || old.farm) : old.farm,
                   farm_id: moved ? farmId : old.farm_id,
                   status: m.status || 'online' };
        await client.query(
          `UPDATE workers SET data=$1, farm_id=$2, updated_at=NOW() WHERE id=$3`,
          [JSON.stringify(merged), merged.farm_id, old.id]
        );
        if (moved) console.log(`[DB] Miner ${old.id} moved: ${old.farm_id}(${old.ip}) → ${farmId}(${m.ip})`);
      } else {
        const fresh = { ...m, id: stableWorkerId(m), farm_id: farmId, cid: '',
                   disabled: false, status: 'online', source: 'auto-poll',
                   added_at: new Date().toISOString() };
        await client.query(
          `INSERT INTO workers(id, data, farm_id) VALUES($1,$2,$3)`,
          [fresh.id, JSON.stringify(fresh), farmId]
        );
      }
    }

    // Mark workers under this farm that WEREN'T in this poll as offline —
    // they've either been unplugged, moved to another farm (handled
    // above), or are unreachable right now
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
  // File-based fallback — same MAC/Serial-first matching as above,
  // simplified for the in-memory/file store
  const existing = loadFallback('workers');
  const nowIps = new Set(minersFoundNow.map(m => m.ip));
  const byId = new Map(existing.map(w => [w.id, w]));

  function findExisting(m) {
    if (m.mac)    { const f = existing.find(w => w.mac === m.mac); if (f) return f; }
    if (m.serial) { const f = existing.find(w => w.serial === m.serial); if (f) return f; }
    return existing.find(w => w.ip === m.ip && w.farm_id === farmId) || null;
  }

  minersFoundNow.forEach(m => {
    const old = findExisting(m);
    if (old) {
      const moved = old.ip !== m.ip || old.farm_id !== farmId;
      byId.set(old.id, { ...old, ...m, id: old.id, cid: old.cid, disabled: old.disabled,
        disabled_reason: old.disabled_reason, disabled_at: old.disabled_at,
        farm: moved ? (m.farm || old.farm) : old.farm,
        farm_id: moved ? farmId : old.farm_id,
        status: m.status || 'online' });
    } else {
      const id = stableWorkerId(m);
      byId.set(id, { ...m, id, farm_id: farmId, cid: '',
        disabled: false, status: 'online', source: 'auto-poll', added_at: new Date().toISOString() });
    }
  });

  // Mark missing-from-this-poll workers (for this farm) as offline
  byId.forEach((w, id) => {
    if (w.farm_id === farmId && !nowIps.has(w.ip) && w.status !== 'offline' && !w.disabled) {
      byId.set(id, { ...w, status: 'offline' });
    }
  });

  return saveFallback('workers', Array.from(byId.values()));
}

async function saveWorkers(workersList, clearAll) {
  if (useFallback || !pool) return saveFallback('workers', workersList, clearAll);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Only wipe the table when explicitly asked to (a real "Clear All"
    // action) — never as a side effect of a normal save. See saveWorkers
    // comment history: an unconditional delete-then-reinsert here used
    // to silently destroy data from other sessions/agents on every save.
    if (clearAll) await client.query('DELETE FROM workers');
    for (const w of workersList) {
      await client.query(
        `INSERT INTO workers(id, data, farm_id) VALUES($1,$2,$3)
         ON CONFLICT (id) DO UPDATE SET data=$2, farm_id=$3, updated_at=NOW()`,
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

async function getWorkerById(id) {
  const all = await loadWorkers();
  return all.find(w => w.id === id) || null;
}

async function findWorkerByFarmAndIp(farmId, ip) {
  const all = await loadWorkers();
  return all.find(w => w.farm_id === farmId && w.ip === ip) || null;
}

// ── Customers CRUD ────────────────────────────────────────
async function saveCustomers(customersList, clearAll) {
  if (useFallback || !pool) return saveFallback('customers', customersList, clearAll);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (clearAll) await client.query('DELETE FROM customers');
    for (const c of customersList) {
      await client.query(
        `INSERT INTO customers(id, data) VALUES($1,$2)
         ON CONFLICT (id) DO UPDATE SET data=$2`,
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
function saveFallback(key, data, clearAll) {
  try {
    let store = {};
    if (fs.existsSync(FALLBACK_FILE)) store = JSON.parse(fs.readFileSync(FALLBACK_FILE,'utf8'));
    if (clearAll || !Array.isArray(store[key])) {
      store[key] = data;
    } else {
      // Merge by id (upsert), matching the PostgreSQL path above —
      // a plain overwrite here had the same silent-data-loss problem
      // as the old saveWorkers/saveCustomers behavior.
      const byId = new Map(store[key].map(item => [item.id, item]));
      data.forEach(item => byId.set(item.id, item));
      store[key] = Array.from(byId.values());
    }
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

async function deleteWorker(id) {
  if (useFallback || !pool) {
    let store = {};
    if (fs.existsSync(FALLBACK_FILE)) store = JSON.parse(fs.readFileSync(FALLBACK_FILE,'utf8'));
    if (Array.isArray(store.workers)) store.workers = store.workers.filter(w => w.id !== id);
    try { fs.writeFileSync(FALLBACK_FILE, JSON.stringify(store), 'utf8'); return true; }
    catch(e) { return false; }
  }
  try {
    await pool.query('DELETE FROM workers WHERE id=$1', [id]);
    return true;
  } catch(e) {
    console.error('[DB] deleteWorker error:', e.message);
    return false;
  }
}

async function deleteCustomer(id) {
  if (useFallback || !pool) {
    let store = {};
    if (fs.existsSync(FALLBACK_FILE)) store = JSON.parse(fs.readFileSync(FALLBACK_FILE,'utf8'));
    if (Array.isArray(store.customers)) store.customers = store.customers.filter(c => c.id !== id);
    try { fs.writeFileSync(FALLBACK_FILE, JSON.stringify(store), 'utf8'); return true; }
    catch(e) { return false; }
  }
  try {
    await pool.query('DELETE FROM customers WHERE id=$1', [id]);
    return true;
  } catch(e) {
    console.error('[DB] deleteCustomer error:', e.message);
    return false;
  }
}

module.exports = { connect, saveWorkers, loadWorkers, getWorkerById, findWorkerByFarmAndIp, deleteWorker, upsertWorkersByIp, saveCustomers, loadCustomers, deleteCustomer, saveAgentConfig, loadAgentConfig, loadAllAgentConfigs, isUsingDB };
