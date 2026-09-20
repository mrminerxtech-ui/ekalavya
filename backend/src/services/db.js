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

    -- Cumulative customer earnings, accrued in short slots by the
    -- backend rather than calculated on the fly when someone opens a
    -- page. Accruing on view would double-count with two viewers and
    -- count nothing while nobody is looking.
    --
    -- One row per customer per day. last_slot is what makes accrual
    -- idempotent: a restart or a duplicate tick re-sends the same slot
    -- id, the WHERE clause on the upsert sees it already credited, and
    -- the row is left alone rather than counted twice.
    CREATE TABLE IF NOT EXISTS customer_earnings (
      customer_id TEXT NOT NULL,
      day         DATE NOT NULL,
      btc         DOUBLE PRECISION NOT NULL DEFAULT 0,
      gross_usd   DOUBLE PRECISION NOT NULL DEFAULT 0,
      hosting_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
      slots       INTEGER NOT NULL DEFAULT 0,
      last_slot   TEXT,
      updated_at  TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (customer_id, day)
    );

    -- Per-miner metric history. Until now the software only ever knew
    -- what was true THIS INSTANT: no trend, no "when did it break", no
    -- uptime figure, and no way to tell a machine that has quietly been
    -- running at 70% for a fortnight from one that is fine.
    --
    -- One row per miner per 10-minute slot. The slot is part of the key
    -- so a restart or a duplicate tick overwrites rather than
    -- duplicating, exactly like customer_earnings.
    CREATE TABLE IF NOT EXISTS miner_metrics (
      worker_id   TEXT NOT NULL,
      slot        TIMESTAMPTZ NOT NULL,
      farm_id     TEXT,
      status      TEXT,
      hashrate_th DOUBLE PRECISION,
      temp        DOUBLE PRECISION,
      fan         INTEGER,
      model       TEXT,
      PRIMARY KEY (worker_id, slot)
    );

    -- Queries are nearly always "this miner over time" or "everything
    -- in this window", so both get an index.
    CREATE INDEX IF NOT EXISTS miner_metrics_slot_idx   ON miner_metrics (slot DESC);
    CREATE INDEX IF NOT EXISTS miner_metrics_worker_idx ON miner_metrics (worker_id, slot DESC);
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
    // above), or are unreachable right now. Their last-known hashrate/
    // temp/fan/worker readings are cleared at the same time — a machine
    // that's offline isn't hashing at its old rate, and leaving that
    // stale number in place made a genuinely dead machine's row look
    // like it was still mining right up until someone opened it.
    const allForFarm = await client.query(`SELECT id, data FROM workers WHERE farm_id = $1`, [farmId]);
    for (const row of allForFarm.rows) {
      if (!nowIps.has(row.data.ip) && row.data.status !== 'offline' && !row.data.disabled) {
        const updated = { ...row.data, status: 'offline',
          hashrate: 0, hr_display: '—', temp: null, fan: null };
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

  // Mark missing-from-this-poll workers (for this farm) as offline, and
  // clear their last-known readings along with it — see the matching
  // comment in upsertWorkersByIp above for why.
  byId.forEach((w, id) => {
    if (w.farm_id === farmId && !nowIps.has(w.ip) && w.status !== 'offline' && !w.disabled) {
      byId.set(id, { ...w, status: 'offline', hashrate: 0, hr_display: '—', temp: null, fan: null });
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

// ── Customer earnings accrual ───────────────────────────────────
// Credits one slot's worth of earnings to a customer. Returns true if
// it was actually credited, false if that slot was already counted
// (a restart, a duplicate tick, two backend instances) — the caller
// can log the difference rather than silently double-paying.
async function accrueEarnings(customerId, day, slot, btc, grossUsd, hostingUsd) {
  if (useFallback || !pool) {
    let store = {};
    if (fs.existsSync(FALLBACK_FILE)) store = JSON.parse(fs.readFileSync(FALLBACK_FILE, 'utf8'));
    store.earnings = store.earnings || {};
    const key = customerId + '|' + day;
    const row = store.earnings[key] || { customer_id: customerId, day, btc: 0, gross_usd: 0, hosting_usd: 0, slots: 0, last_slot: null };
    if (row.last_slot === slot) return false;
    row.btc += btc; row.gross_usd += grossUsd; row.hosting_usd += hostingUsd;
    row.slots += 1; row.last_slot = slot;
    store.earnings[key] = row;
    try { fs.writeFileSync(FALLBACK_FILE, JSON.stringify(store), 'utf8'); return true; }
    catch(e) { return false; }
  }
  try {
    const r = await pool.query(
      `INSERT INTO customer_earnings (customer_id, day, btc, gross_usd, hosting_usd, slots, last_slot)
       VALUES ($1,$2,$3,$4,$5,1,$6)
       ON CONFLICT (customer_id, day) DO UPDATE SET
         btc         = customer_earnings.btc         + EXCLUDED.btc,
         gross_usd   = customer_earnings.gross_usd   + EXCLUDED.gross_usd,
         hosting_usd = customer_earnings.hosting_usd + EXCLUDED.hosting_usd,
         slots       = customer_earnings.slots + 1,
         last_slot   = EXCLUDED.last_slot,
         updated_at  = NOW()
       WHERE customer_earnings.last_slot IS DISTINCT FROM EXCLUDED.last_slot
       RETURNING customer_id`,
      [customerId, day, btc, grossUsd, hostingUsd, slot]
    );
    return r.rowCount > 0;
  } catch(e) {
    console.error('[DB] accrueEarnings error:', e.message);
    return false;
  }
}

// Lifetime totals plus today's, for one customer.
async function getEarningsSummary(customerId) {
  const today = new Date().toISOString().slice(0, 10);
  const empty = { total_btc: 0, total_gross_usd: 0, total_hosting_usd: 0,
                  today_btc: 0, today_gross_usd: 0, today_hosting_usd: 0,
                  since: null, days_recorded: 0 };
  if (useFallback || !pool) {
    let store = {};
    if (fs.existsSync(FALLBACK_FILE)) store = JSON.parse(fs.readFileSync(FALLBACK_FILE, 'utf8'));
    const rows = Object.values(store.earnings || {}).filter(r => r.customer_id === customerId);
    if (rows.length === 0) return empty;
    const t = rows.find(r => r.day === today);
    return {
      total_btc:         rows.reduce((a, r) => a + (r.btc || 0), 0),
      total_gross_usd:   rows.reduce((a, r) => a + (r.gross_usd || 0), 0),
      total_hosting_usd: rows.reduce((a, r) => a + (r.hosting_usd || 0), 0),
      today_btc:         t ? t.btc : 0,
      today_gross_usd:   t ? t.gross_usd : 0,
      today_hosting_usd: t ? t.hosting_usd : 0,
      since:             rows.map(r => r.day).sort()[0],
      days_recorded:     rows.length,
    };
  }
  try {
    const [all, today_] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(btc),0) btc, COALESCE(SUM(gross_usd),0) g,
                         COALESCE(SUM(hosting_usd),0) h, MIN(day) since, COUNT(*) n
                  FROM customer_earnings WHERE customer_id=$1`, [customerId]),
      pool.query(`SELECT btc, gross_usd, hosting_usd FROM customer_earnings
                  WHERE customer_id=$1 AND day=$2`, [customerId, today]),
    ]);
    const a = all.rows[0] || {};
    const t = today_.rows[0] || {};
    return {
      total_btc:         Number(a.btc) || 0,
      total_gross_usd:   Number(a.g)   || 0,
      total_hosting_usd: Number(a.h)   || 0,
      today_btc:         Number(t.btc) || 0,
      today_gross_usd:   Number(t.gross_usd) || 0,
      today_hosting_usd: Number(t.hosting_usd) || 0,
      since:             a.since ? new Date(a.since).toISOString().slice(0, 10) : null,
      days_recorded:     Number(a.n) || 0,
    };
  } catch(e) {
    console.error('[DB] getEarningsSummary error:', e.message);
    return empty;
  }
}

// Per-day history for one customer, newest first.
async function getEarningsHistory(customerId, limit) {
  limit = Math.min(Number(limit) || 90, 400);
  if (useFallback || !pool) {
    let store = {};
    if (fs.existsSync(FALLBACK_FILE)) store = JSON.parse(fs.readFileSync(FALLBACK_FILE, 'utf8'));
    return Object.values(store.earnings || {})
      .filter(r => r.customer_id === customerId)
      .sort((a, b) => (a.day < b.day ? 1 : -1))
      .slice(0, limit);
  }
  try {
    const r = await pool.query(
      `SELECT to_char(day,'YYYY-MM-DD') day, btc, gross_usd, hosting_usd, slots
       FROM customer_earnings WHERE customer_id=$1 ORDER BY day DESC LIMIT $2`,
      [customerId, limit]
    );
    return r.rows;
  } catch(e) {
    console.error('[DB] getEarningsHistory error:', e.message);
    return [];
  }
}

// ── Miner metric history ────────────────────────────────────

// Written in one statement per slot rather than one per miner: on a
// 97-machine fleet that's one round trip instead of 97, every ten
// minutes.
async function recordMetrics(slotIso, rows) {
  if (!rows || !rows.length) return 0;

  if (useFallback || !pool) {
    // The file store is a stand-in for a real database and must not be
    // allowed to grow without bound, so it keeps a short window only.
    let store = {};
    if (fs.existsSync(FALLBACK_FILE)) {
      try { store = JSON.parse(fs.readFileSync(FALLBACK_FILE, 'utf8')); } catch(e) { store = {}; }
    }
    store.metrics = store.metrics || [];
    rows.forEach(r => store.metrics.push({ slot: slotIso, ...r }));
    const cutoff = Date.now() - 2 * 24 * 60 * 60 * 1000;   // 2 days
    store.metrics = store.metrics.filter(m => new Date(m.slot).getTime() >= cutoff);
    try { fs.writeFileSync(FALLBACK_FILE, JSON.stringify(store), 'utf8'); return rows.length; }
    catch(e) { return 0; }
  }

  const vals = [];
  const params = [];
  rows.forEach((r, i) => {
    const b = i * 8;
    vals.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8})`);
    params.push(r.worker_id, slotIso, r.farm_id || null, r.status || null,
                r.hashrate_th, r.temp, r.fan, r.model || null);
  });

  try {
    await pool.query(
      `INSERT INTO miner_metrics (worker_id, slot, farm_id, status, hashrate_th, temp, fan, model)
       VALUES ${vals.join(',')}
       ON CONFLICT (worker_id, slot) DO UPDATE SET
         status = EXCLUDED.status, hashrate_th = EXCLUDED.hashrate_th,
         temp = EXCLUDED.temp, fan = EXCLUDED.fan, model = EXCLUDED.model`,
      params
    );
    return rows.length;
  } catch(e) {
    console.error('[DB] recordMetrics error:', e.message);
    return 0;
  }
}

// History is for spotting trends, not for keeping forever. Old slots
// are dropped so the table stays a predictable size.
async function pruneMetrics(days) {
  if (useFallback || !pool) return 0;
  try {
    const r = await pool.query(
      `DELETE FROM miner_metrics WHERE slot < NOW() - ($1 || ' days')::interval`,
      [String(days || 30)]
    );
    return r.rowCount || 0;
  } catch(e) {
    console.error('[DB] pruneMetrics error:', e.message);
    return 0;
  }
}

async function getWorkerHistory(workerId, hours) {
  const h = Math.min(Math.max(parseInt(hours, 10) || 24, 1), 24 * 30);
  if (useFallback || !pool) {
    let store = {};
    try { store = JSON.parse(fs.readFileSync(FALLBACK_FILE, 'utf8')); } catch(e) { return []; }
    const cutoff = Date.now() - h * 3600 * 1000;
    return (store.metrics || [])
      .filter(m => m.worker_id === workerId && new Date(m.slot).getTime() >= cutoff)
      .sort((a, b) => new Date(a.slot) - new Date(b.slot));
  }
  try {
    const r = await pool.query(
      `SELECT slot, status, hashrate_th, temp, fan
         FROM miner_metrics
        WHERE worker_id = $1 AND slot >= NOW() - ($2 || ' hours')::interval
        ORDER BY slot ASC`,
      [workerId, String(h)]
    );
    return r.rows;
  } catch(e) {
    console.error('[DB] getWorkerHistory error:', e.message);
    return [];
  }
}

// Uptime measured as "slots seen hashing ÷ slots observed". Slots where
// nothing was recorded at all (backend down) are simply absent, so they
// neither help nor hurt a machine's figure — the alternative would be
// blaming miners for our own downtime.
async function getUptimeReport(days, farmId) {
  const d = Math.min(Math.max(parseInt(days, 10) || 7, 1), 90);
  if (useFallback || !pool) {
    let store = {};
    try { store = JSON.parse(fs.readFileSync(FALLBACK_FILE, 'utf8')); } catch(e) { return []; }
    const cutoff = Date.now() - d * 86400000;
    const by = {};
    (store.metrics || []).forEach(m => {
      if (new Date(m.slot).getTime() < cutoff) return;
      if (farmId && m.farm_id !== farmId) return;
      const k = m.worker_id;
      by[k] = by[k] || { worker_id: k, farm_id: m.farm_id, model: m.model, slots: 0, online: 0, avg: 0, sum: 0, n: 0 };
      by[k].slots++;
      if (m.status === 'online') { by[k].online++; if (m.hashrate_th > 0) { by[k].sum += m.hashrate_th; by[k].n++; } }
    });
    return Object.values(by).map(r => ({
      worker_id: r.worker_id, farm_id: r.farm_id, model: r.model,
      slots_observed: r.slots, slots_online: r.online,
      uptime_pct: r.slots ? (100 * r.online / r.slots) : null,
      avg_hashrate_th: r.n ? (r.sum / r.n) : null,
    }));
  }
  try {
    const r = await pool.query(
      `SELECT worker_id,
              MAX(farm_id)  AS farm_id,
              MAX(model)    AS model,
              COUNT(*)                                         AS slots_observed,
              COUNT(*) FILTER (WHERE status = 'online')        AS slots_online,
              100.0 * COUNT(*) FILTER (WHERE status = 'online') / NULLIF(COUNT(*),0) AS uptime_pct,
              AVG(hashrate_th) FILTER (WHERE status = 'online' AND hashrate_th > 0)  AS avg_hashrate_th,
              AVG(temp)        FILTER (WHERE status = 'online' AND temp > 0)         AS avg_temp
         FROM miner_metrics
        WHERE slot >= NOW() - ($1 || ' days')::interval
          AND ($2::text IS NULL OR farm_id = $2)
        GROUP BY worker_id`,
      [String(d), farmId || null]
    );
    return r.rows;
  } catch(e) {
    console.error('[DB] getUptimeReport error:', e.message);
    return [];
  }
}

module.exports = { connect, saveWorkers, loadWorkers, getWorkerById, findWorkerByFarmAndIp, deleteWorker, upsertWorkersByIp, saveCustomers, loadCustomers, deleteCustomer, saveAgentConfig, loadAgentConfig, loadAllAgentConfigs, isUsingDB, accrueEarnings, getEarningsSummary, getEarningsHistory, recordMetrics, pruneMetrics, getWorkerHistory, getUptimeReport };
