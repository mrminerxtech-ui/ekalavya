// ============================================================
// DATABASE — PostgreSQL via Railway
// Auto-creates tables on first run
// Falls back to a JSON file if PostgreSQL isn't reachable
// ============================================================
const { Pool } = require('pg');

let pool = null;
let useFallback = false;
let connecting = null;      // in-flight connect(), so we only ever run one
let retryTimer = null;

// The fallback file is a LAST RESORT, not a storage option.
//
// On a hosted platform the container's filesystem is thrown away and
// rebuilt on every deploy, so anything living here disappears the next
// time the software is updated — including customer portal passwords
// and team logins, which exist nowhere else. That is exactly what
// "credentials erased after an update" looks like.
//
// Set FALLBACK_FILE to a path on a mounted volume if you want this to
// survive at all; the only real fix is a working DATABASE_URL.
const FALLBACK_FILE = process.env.FALLBACK_FILE || '/tmp/ekl-fleet.json';
const fs = require('fs');

function warnEphemeralStorage(reason) {
  console.warn('');
  console.warn('╔════════════════════════════════════════════════════════════╗');
  console.warn('║  ⚠  RUNNING WITHOUT A DATABASE — DATA WILL BE LOST         ║');
  console.warn('╚════════════════════════════════════════════════════════════╝');
  console.warn(`[DB] Reason: ${reason}`);
  console.warn(`[DB] Storing everything in ${FALLBACK_FILE} instead.`);
  console.warn('[DB] On Railway this file is wiped on every redeploy, which');
  console.warn('[DB] erases customer portal passwords and team logins — they');
  console.warn('[DB] are not stored anywhere else and cannot be recovered.');
  console.warn('[DB] Fix: set DATABASE_URL to your Postgres instance.');
  console.warn('');
}

// ── Connect ───────────────────────────────────────────────
// Postgres often isn't accepting connections yet at the instant this
// process starts (the database container is still coming up after a
// deploy). The previous version tried exactly once and, on failure,
// switched to the file store permanently — so a database that became
// reachable two seconds later went unused until someone restarted the
// app, and everything written in between was lost on the next deploy.
// This retries, and keeps retrying in the background.
const CONNECT_ATTEMPTS  = 5;
const RETRY_INTERVAL_MS = 30000;

async function connect() {
  // One attempt at a time. Once connected, the guard stays so we never
  // reconnect needlessly; if we ended up on the fallback, the guard is
  // released so a later call (the retry timer, or anything else) can
  // try again.
  if (connecting) return connecting;
  connecting = (async () => {
    if (!process.env.DATABASE_URL) {
      useFallback = true;
      warnEphemeralStorage('DATABASE_URL is not set');
      return;
    }
    for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt++) {
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
        console.log(`[DB] ✓ PostgreSQL connected${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
        await createTables();
        const wasOnFallback = useFallback;
        useFallback = false;
        if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
        // Anything written while the database was unreachable is still
        // sitting in the fallback file — move it in rather than leaving
        // it to be wiped with the container.
        if (wasOnFallback) await importFallbackFile();
        return;
      } catch(e) {
        try { if (pool) await pool.end(); } catch(_) {}
        pool = null;
        console.error(`[DB] Connection attempt ${attempt}/${CONNECT_ATTEMPTS} failed: ${e.message}`);
        if (attempt < CONNECT_ATTEMPTS) {
          await new Promise(r => setTimeout(r, 2000 * attempt));  // 2s, 4s, 6s, 8s
        }
      }
    }
    useFallback = true;
    warnEphemeralStorage('PostgreSQL could not be reached');
    // Keep trying — the moment it comes up, switch over and carry the
    // fallback file's contents across.
    if (!retryTimer) {
      retryTimer = setInterval(() => {
        console.log('[DB] Retrying PostgreSQL connection...');
        connect().catch(() => {});
      }, RETRY_INTERVAL_MS);
      if (retryTimer.unref) retryTimer.unref();
    }
  })();

  const attempt = connecting;
  try {
    return await attempt;
  } finally {
    // Still on the fallback — let the next caller try again.
    if (useFallback && connecting === attempt) connecting = null;
  }
}

// Whatever was written while the database was down gets carried into
// Postgres, then the file is set aside so it can't be imported twice.
async function importFallbackFile() {
  try {
    if (!fs.existsSync(FALLBACK_FILE)) return;
    const store = JSON.parse(fs.readFileSync(FALLBACK_FILE, 'utf8'));
    const workers   = Array.isArray(store.workers)   ? store.workers   : [];
    const customers = Array.isArray(store.customers) ? store.customers : [];
    const teamers   = Array.isArray(store.team_members) ? store.team_members : [];
    if (!workers.length && !customers.length && !teamers.length) return;

    console.log(`[DB] Carrying ${workers.length} machine(s), ${customers.length} customer(s) and ${teamers.length} team account(s) from the fallback file into PostgreSQL`);
    if (workers.length)   await saveWorkers(workers);
    if (customers.length) await saveCustomers(customers);
    for (const m of teamers) await saveTeamMember(m);

    fs.renameSync(FALLBACK_FILE, FALLBACK_FILE + '.imported-' + Date.now());
    console.log('[DB] ✓ Fallback data imported');
  } catch(e) {
    console.error('[DB] Could not import fallback file (left in place):', e.message);
  }
}

// The connection is started here rather than relying on something else
// to call connect(). If a caller does call it, the guard above means
// this still only happens once.
connect().catch(e => console.error('[DB] Startup connect failed:', e.message));

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

    -- Real staff accounts an admin creates from the Team Access page —
    -- separate from the three hardcoded demo logins in auth.js. Each
    -- one gets its own username/password (hashed, same as customers)
    -- and role, and can log in for real once created here.
    CREATE TABLE IF NOT EXISTS team_members (
      id          TEXT PRIMARY KEY,
      data        JSONB NOT NULL,
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );

    -- Record of things a person DELETED on purpose.
    --
    -- Every device keeps its own local copy of the fleet and pushes the
    -- whole list back on save. Deleting a customer on a laptop removes
    -- it from the laptop and from the server — but a phone that still
    -- has yesterday's copy will happily push that customer back up the
    -- next time anything is saved there, and the deletion undoes
    -- itself. "Absent from the list" can't be told apart from "not
    -- created yet", so the deletion has to be recorded explicitly.
    -- Saves drop anything listed here, and each device prunes its own
    -- local copy from this list on load.
    CREATE TABLE IF NOT EXISTS deleted_records (
      id          TEXT NOT NULL,
      kind        TEXT NOT NULL,
      deleted_at  TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (id, kind)
    );

    -- Hand-entered power draw, per MODEL rather than per machine.
    --
    -- Plenty of miners never report their own wattage, and not every
    -- model is in the built-in spec table — so those machines can't be
    -- counted in a site's power total at all. Rather than making
    -- someone type a figure into all 40 machines of that model, the
    -- number is stored once against the model and every machine of that
    -- model picks it up, at every site, on every device.
    --
    -- model_key is the model name reduced to letters and digits, so the
    -- many ways firmware writes the same model ("Antminer L9",
    -- "ANTMINER-L9", "Antminer L9 (17Gh)") all resolve to one row.
    -- label keeps the name as it was actually seen, for display.
    --
    -- force: a machine's own firmware reading normally wins over this —
    -- it's a live measurement, this is someone's best guess. But some
    -- sites have miners whose firmware reports a NUMBER, just the wrong
    -- one (a hydro-cooled unit sharing a board with the air-cooled
    -- variant's PSU curve, for instance), which the plausibility check
    -- can't catch because the number itself looks like a normal wattage.
    -- force=true means the entered figure was measured against reality
    -- (a clamp meter, the PDU) and is trusted over what the miner says.
    CREATE TABLE IF NOT EXISTS model_power (
      model_key   TEXT PRIMARY KEY,
      watts       INTEGER NOT NULL,
      label       TEXT,
      force       BOOLEAN NOT NULL DEFAULT false,
      set_by      TEXT,
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

  // model_power shipped before the "force" column existed. CREATE TABLE
  // IF NOT EXISTS leaves an already-created table untouched, so a
  // deployment that already has this table needs the column added
  // explicitly — otherwise every saveModelPower() call with a force
  // flag fails against a database that's never heard of it.
  await pool.query(`ALTER TABLE model_power ADD COLUMN IF NOT EXISTS force BOOLEAN NOT NULL DEFAULT false;`);

  // One-time backfill for machines that were auto-discovered before the
  // fix below existed. upsertWorkersByIp's fresh-insert path used to
  // spread the agent's raw poll data straight into a new row with no
  // fallback for `name` at all — and the agent's own payload never
  // includes one — so every machine first discovered server-side (the
  // normal case; this is what every device actually loads from) ended
  // up with a permanently blank name. The insert path is fixed to set
  // a sensible default going forward (the miner's own pool worker name,
  // or its IP with dots turned to dashes), but rows already sitting in
  // the database from before that fix need the same default applied
  // once, here, rather than staying blank forever.
  try {
    const backfilled = await pool.query(`
      UPDATE workers
      SET data = data || jsonb_build_object('name',
        COALESCE(
          NULLIF(data->>'worker', ''),
          NULLIF(data->>'name', ''),
          replace(data->>'ip', '.', '-'),
          id
        ))
      WHERE COALESCE(data->>'name', '') = ''
    `);
    if (backfilled.rowCount > 0) console.log(`[DB] Backfilled a default name onto ${backfilled.rowCount} previously-unnamed machine(s)`);
  } catch(e) {
    console.error('[DB] Worker name backfill failed (non-fatal):', e.message);
  }

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

// Identity only works if it's unique. Some firmware reports a MAC (or
// serial) that ISN'T the machine's own — a factory default, a value
// copied across a whole production batch, or a string scraped out of a
// boot log that reads the same on every unit of that model. When that
// happens, every one of those machines matches the same saved record
// and they collapse into one: the record jumps from IP to IP several
// times a second, the other machines vanish from the fleet, and their
// customer assignment and history are mixed together.
//
// A machine can legitimately change IP, but two machines cannot be at
// two IPs at the same instant. So any MAC or serial claimed by more
// than one machine in the SAME poll is not an identity — it's dropped
// for matching, and those machines fall through to the identifiers
// that are still trustworthy (pool worker ID, then IP).
// Shortest believable gap between the same machine being seen at one
// farm and then another: it has to be physically moved.
const RELOCATION_MIN_GAP_MS = 5 * 60 * 1000;

// ── A machine that isn't running isn't producing readings ──────────
// Hashrate, temperature and fan speed are only meaningful while a
// machine is actually up. The poll paths below already clear them when
// they mark something offline, but that was never the only way a record
// got written: every browser and phone with the app open pushes its
// WHOLE local fleet list back through POST /api/fleet/save, and that
// save overwrote the stored record verbatim. A device holding a cached
// copy from before a machine went down would therefore re-upload the old
// hashrate and temperature straight over the cleared values — and
// because the poll's clearing pass skips rows that are already marked
// offline, nothing ever cleaned it up again. The row stayed offline and
// "hashing at 15 GH/s, 80°C" indefinitely.
//
// So this is enforced at the point of storage instead of at each caller.
// Whatever the source — poll, agent disconnect, or a client push — a
// record that isn't online or in warning cannot carry live readings into
// the database. 'warn' is kept because a machine over temperature is
// still mining, which is exactly why it's worth warning about.
const LIVE_STATUSES = ['online', 'warn'];

function sanitizeWorkerReadings(w) {
  if (!w || typeof w !== 'object') return w;
  if (LIVE_STATUSES.includes(w.status)) return w;
  if (!w.hashrate && w.temp == null && w.fan == null &&
      (!w.hr_display || w.hr_display === '—')) return w;   // already clean
  return { ...w, hashrate: 0, hr_display: '—', temp: null, fan: null };
}

// True when a stored row is offline but still carrying readings — the
// state described above. Used to re-clean records that were poisoned
// before this rule existed, since they're already marked offline and so
// would otherwise be skipped by the mark-offline passes forever.
function hasStaleReadings(w) {
  if (!w || LIVE_STATUSES.includes(w.status)) return false;
  return !!w.hashrate || w.temp != null || w.fan != null ||
         (!!w.hr_display && w.hr_display !== '—');
}

function scrubCollidingIds(farmId, miners) {
  const seen = { mac: new Map(), serial: new Map() };
  miners.forEach(m => {
    if (!m) return;
    ['mac', 'serial'].forEach(field => {
      const v = m[field];
      if (!v) return;
      if (!seen[field].has(v)) seen[field].set(v, []);
      seen[field].get(v).push(m);
    });
  });

  const collisions = [];
  ['mac', 'serial'].forEach(field => {
    seen[field].forEach((claimants, value) => {
      if (claimants.length < 2) return;
      collisions.push({
        field, value,
        ips: claimants.map(m => m.ip),
        source: claimants[0].mac_source || 'firmware',
      });
      claimants.forEach(m => {
        m['bad_' + field] = value;   // kept for display, never for matching
        m[field] = null;
      });
    });
  });

  collisions.forEach(c => {
    console.warn(`[DB] ⚠ ${c.ips.length} machines on ${farmId} all report ${c.field} ${c.value} ` +
                 `(via ${c.source}) — ignoring it as an identity for: ${c.ips.join(', ')}`);
  });
  return collisions;
}

async function upsertWorkersByIp(farmId, minersFoundNow) {
  minersFoundNow = minersFoundNow || [];
  const collisions = scrubCollidingIds(farmId, minersFoundNow);
  if (useFallback || !pool) return upsertWorkersFallback(farmId, minersFoundNow, collisions);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const nowIps = new Set(minersFoundNow.map(m => m.ip));

    // A record already saved under a colliding ID is poisoned too — it
    // holds whichever machine wrote last. Clear the bad value off it so
    // it stops matching, and so the "Find & Merge Duplicates" tool
    // doesn't see several different machines as copies of one.
    for (const c of collisions) {
      const patch = {};
      patch[c.field] = null;
      patch['bad_' + c.field] = c.value;
      const r = await client.query(
        `UPDATE workers SET data = data || $2::jsonb WHERE data->>$3 = $1`,
        [c.value, JSON.stringify(patch), c.field]
      );
      if (r.rowCount > 0) console.warn(`[DB]   cleared that ${c.field} off ${r.rowCount} saved record(s)`);
    }

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
      // The same collision can also span two farms — one site's batch
      // can't see the other's. A machine CAN be physically moved
      // between farms, but not in the seconds between two polls: that
      // takes unracking, transport and re-racking. So a record that
      // another farm updated moments ago isn't this machine.
      const claimedElsewhere = (row) => {
        if (!row || row.farm_id === farmId) return false;
        const age = Date.now() - new Date(row.updated_at).getTime();
        if (age > RELOCATION_MIN_GAP_MS) return false;   // plausible move
        console.warn(`[DB] ⚠ ${m.ip} (${farmId}) claims the identity of a machine ` +
                     `${row.farm_id} reported ${Math.round(age/1000)}s ago — treating as a duplicate ID, not a move`);
        return true;
      };

      // FOR UPDATE below: without it, this SELECT takes a plain snapshot
      // of the row and the merge further down builds on THAT snapshot —
      // so if a human's "Assign Miners" action commits a new cid (or a
      // disable/rename) on this same row in the gap between this read
      // and this transaction's own write, that update is invisible here
      // and gets silently reverted back to the stale value read a moment
      // ago. This is exactly the bug that made 3 of 6 newly-assigned
      // customer miners "vanish" — their farm's ~30s auto-poll happened
      // to race the assign click. FOR UPDATE takes a row lock at read
      // time; if another transaction (the assign flow's own saveWorkers
      // upsert) is mid-write on this row, this SELECT blocks until it
      // commits, then reads its LATEST value instead of a stale one —
      // so cid/disabled/name can no longer be reverted by a racing poll.
      let existing = null;
      if (m.mac) {
        const byMac = await client.query(`SELECT id, data, farm_id, updated_at FROM workers WHERE data->>'mac' = $1 FOR UPDATE`, [m.mac]);
        if (byMac.rows.length > 0 && !claimedElsewhere(byMac.rows[0])) existing = byMac.rows[0];
      }
      if (!existing && m.serial) {
        const bySerial = await client.query(`SELECT id, data, farm_id, updated_at FROM workers WHERE data->>'serial' = $1 FOR UPDATE`, [m.serial]);
        if (bySerial.rows.length > 0 && !claimedElsewhere(bySerial.rows[0])) existing = bySerial.rows[0];
      }
      // Last hardware-based fallback: the pool Worker ID (the
      // wallet.worker-name string configured ON the miner) survives a
      // reboot and a new DHCP lease even on a machine whose MAC/Serial
      // were never successfully read — exactly the case when an entire
      // farm reboots at once after a power outage. Without this, every
      // such machine would silently split into a permanently-offline
      // orphan plus a brand-new "unknown machine" record at its new IP.
      if (!existing && m.worker_id && m.worker_id !== '—') {
        const byWid = await client.query(
          `SELECT id, data, farm_id, updated_at FROM workers WHERE data->>'worker_id' = $1 AND data->>'worker_id' != '—' FOR UPDATE`,
          [m.worker_id]
        );
        if (byWid.rows.length > 0 && !claimedElsewhere(byWid.rows[0])) existing = byWid.rows[0];
      }
      if (!existing) {
        const byIp = await client.query(`SELECT id, data FROM workers WHERE data->>'ip' = $1 AND farm_id = $2 FOR UPDATE`, [m.ip, farmId]);
        if (byIp.rows.length > 0) existing = byIp.rows[0];
      }

      if (existing) {
        const old = existing.data;
        const moved = old.ip !== m.ip || old.farm_id !== farmId;
        // This is why the name backfill kept "not sticking": `{...old,
        // ...m}` lets ANY key present in the agent's own poll payload
        // silently win over what's already saved, and the agent's miner
        // objects apparently do carry a `name` key of their own (usually
        // blank) — so every ~30s poll was overwriting the backfilled
        // name right back to blank again, undoing the migration within
        // one poll cycle of it running. name is now protected the same
        // way cid/disabled already are: only ever take the agent's name
        // when it's a real non-empty value, never let a blank one win.
        const newName = (m.name && String(m.name).trim()) ? m.name
          : (old.name || m.worker || (m.ip ? m.ip.replace(/\./g, '-') : old.id));
        // Same "never let a blank reading overwrite a good one" protection
        // as name/cid/disabled, extended to model/worker/pool. These were
        // still exposed to the plain {...old, ...m} spread, so a single
        // poll cycle where the miner's own web server was too busy to
        // answer in time (confirmed happening — its embedded server can
        // only handle so much, and something was hammering it once a
        // second) silently reset a correctly-identified machine back to
        // "Unknown"/blank, even though the underlying read that produced
        // those was itself a genuine success just moments earlier.
        const keepIfBetter = (newVal, oldVal, blankValues) =>
          (newVal && !blankValues.includes(newVal)) ? newVal : (oldVal || newVal);
        const merged = { ...old, ...m, id: old.id, cid: old.cid, disabled: old.disabled,
                   disabled_reason: old.disabled_reason, disabled_at: old.disabled_at,
                   // If it moved, adopt the NEW farm/ip — that's genuinely
                   // where it is now. Otherwise keep exactly as before.
                   farm: moved ? (m.farm || old.farm) : old.farm,
                   farm_id: moved ? farmId : old.farm_id,
                   name: newName,
                   model:     keepIfBetter(m.model,     old.model,     ['Unknown']),
                   brand:     keepIfBetter(m.brand,      old.brand,     ['']),
                   worker:    keepIfBetter(m.worker,     old.worker,    ['—']),
                   worker_id: keepIfBetter(m.worker_id,  old.worker_id, ['—']),
                   pool:      keepIfBetter(m.pool,       old.pool,      ['—']),
                   status: m.status || 'online' };
        await client.query(
          `UPDATE workers SET data=$1, farm_id=$2, updated_at=NOW() WHERE id=$3`,
          [JSON.stringify(sanitizeWorkerReadings(merged)), merged.farm_id, old.id]
        );
        if (moved) console.log(`[DB] Miner ${old.id} moved: ${old.farm_id}(${old.ip}) → ${farmId}(${m.ip})`);
      } else {
        // Every OTHER place a fresh worker record gets built (the
        // frontend's own mergePollResults, for the live-WebSocket path)
        // defaults name to the miner's configured pool worker name, or
        // its IP with dots turned to dashes, if nothing else is set.
        // This insert path — the one that actually runs server-side on
        // every poll, DB-backed and authoritative for every device —
        // never did that: it just spread `m` as-is, and the agent's own
        // poll payload has no `name` field at all. So a machine first
        // discovered here (which is the normal case) got no name ever,
        // and every device loading from /api/fleet/load saw it as blank
        // forever, since loadFleetFromBackend never invents one either.
        const defaultName = m.name || m.worker || (m.ip ? m.ip.replace(/\./g, '-') : stableWorkerId(m));
        const fresh = { ...m, id: stableWorkerId(m), farm_id: farmId, cid: '',
                   disabled: false, status: 'online', source: 'auto-poll',
                   name: defaultName,
                   added_at: new Date().toISOString() };
        await client.query(
          `INSERT INTO workers(id, data, farm_id) VALUES($1,$2,$3)`,
          [fresh.id, JSON.stringify(fresh), farmId]
        );
        // A machine that was deleted from the fleet but is still
        // plugged in and hashing will be rediscovered here. That's a
        // legitimate re-appearance, so drop its deletion record —
        // otherwise every device would keep pruning it back out.
        await client.query('DELETE FROM deleted_records WHERE id=$1 AND kind=$2', [fresh.id, 'worker']);
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
    let cleaned = 0;
    for (const row of allForFarm.rows) {
      if (nowIps.has(row.data.ip) || row.data.disabled) continue;
      const goingOffline = row.data.status !== 'offline';
      // A row that is ALREADY marked offline used to be skipped outright,
      // which is why records that had been re-seeded with stale readings
      // by a client push stayed "offline at 15 GH/s, 80°C" forever. They
      // are re-cleaned here instead of being passed over.
      const dirty = hasStaleReadings(row.data);
      if (!goingOffline && !dirty) continue;
      const updated = { ...row.data, status: 'offline',
        hashrate: 0, hr_display: '—', temp: null, fan: null };
      // Only a genuine status change bumps updated_at. A silent cleanup
      // must not: another farm's poller reads updated_at to decide
      // whether a machine could plausibly have been moved here, and a
      // freshly-touched timestamp would make a real relocation look like
      // a duplicate identity for the next few minutes.
      await client.query(
        goingOffline
          ? `UPDATE workers SET data=$1, updated_at=NOW() WHERE id=$2`
          : `UPDATE workers SET data=$1 WHERE id=$2`,
        [JSON.stringify(updated), row.id]
      );
      if (!goingOffline) cleaned++;
    }
    if (cleaned) console.log(`[DB] Cleared stale readings from ${cleaned} offline record(s) on ${farmId}`);

    await client.query('COMMIT');
    return true;
  } catch(e) {
    await client.query('ROLLBACK');
    console.error('[DB] upsertWorkersByIp error:', e.message);
    return false;
  } finally { client.release(); }
}

function upsertWorkersFallback(farmId, minersFoundNow, collisions) {
  // File-based fallback — same MAC/Serial-first matching as above,
  // simplified for the in-memory/file store
  const existing = loadFallback('workers');
  // Same clean-up as the database path: a saved record holding a
  // colliding ID must stop matching on it.
  (collisions || []).forEach(c => {
    existing.forEach(w => {
      if (w && w[c.field] === c.value) { w['bad_' + c.field] = c.value; w[c.field] = null; }
    });
  });
  const nowIps = new Set(minersFoundNow.map(m => m.ip));
  const byId = new Map(existing.map(w => [w.id, w]));

  function findExisting(m) {
    if (m.mac)    { const f = existing.find(w => w.mac === m.mac); if (f) return f; }
    if (m.serial) { const f = existing.find(w => w.serial === m.serial); if (f) return f; }
    // Pool Worker ID fallback — see the matching comment in
    // upsertWorkersByIp above for why this matters after a reboot.
    if (m.worker_id && m.worker_id !== '—') {
      const f = existing.find(w => w.worker_id === m.worker_id && w.worker_id !== '—'); if (f) return f;
    }
    return existing.find(w => w.ip === m.ip && w.farm_id === farmId) || null;
  }

  minersFoundNow.forEach(m => {
    const old = findExisting(m);
    if (old) {
      const moved = old.ip !== m.ip || old.farm_id !== farmId;
      // Same name-protection fix as upsertWorkersByIp above.
      const newName = (m.name && String(m.name).trim()) ? m.name
        : (old.name || m.worker || (m.ip ? m.ip.replace(/\./g, '-') : old.id));
      byId.set(old.id, { ...old, ...m, id: old.id, cid: old.cid, disabled: old.disabled,
        disabled_reason: old.disabled_reason, disabled_at: old.disabled_at,
        farm: moved ? (m.farm || old.farm) : old.farm,
        farm_id: moved ? farmId : old.farm_id,
        name: newName,
        status: m.status || 'online' });
    } else {
      const id = stableWorkerId(m);
      // Same missing-name fix as upsertWorkersByIp above.
      const defaultName = m.name || m.worker || (m.ip ? m.ip.replace(/\./g, '-') : id);
      byId.set(id, { ...m, id, farm_id: farmId, cid: '',
        disabled: false, status: 'online', source: 'auto-poll', name: defaultName, added_at: new Date().toISOString() });
      // Rediscovered after deletion — see the matching comment in
      // upsertWorkersByIp above.
      clearTombstone('worker', id).catch(function(){});
    }
  });

  // Mark missing-from-this-poll workers (for this farm) as offline, and
  // clear their last-known readings along with it — see the matching
  // comment in upsertWorkersByIp above for why.
  byId.forEach((w, id) => {
    if (w.farm_id !== farmId || nowIps.has(w.ip) || w.disabled) return;
    // Already-offline rows are re-cleaned rather than skipped — see the
    // matching comment in upsertWorkersByIp for why they can be dirty.
    if (w.status === 'offline' && !hasStaleReadings(w)) return;
    byId.set(id, { ...w, status: 'offline', hashrate: 0, hr_display: '—', temp: null, fan: null });
  });

  return saveFallback('workers', Array.from(byId.values()));
}

// ── Clear live readings the moment an agent connection itself is lost
// (explicit disconnect, or a missed-heartbeat timeout) — not tied to any
// poll. upsertWorkersByIp/Fallback only run when a poll actually arrives
// from that farm; if the agent is down, no poll ever arrives, so nothing
// clears the last hashrate/temp/fan it reported. That left a genuinely
// dead machine's row looking like it was still hashing, badged OFFLINE
// only because the frontend separately checks agent connectivity.
async function clearFarmReadings(farmId) {
  if (useFallback || !pool) {
    const existing = loadFallback('workers');
    let changed = false;
    existing.forEach(w => {
      if (!w || w.farm_id !== farmId || w.disabled) return;
      if (w.status === 'offline' && !hasStaleReadings(w)) return;
      w.status = 'offline'; w.hashrate = 0; w.hr_display = '—'; w.temp = null; w.fan = null;
      changed = true;
    });
    if (changed) saveFallback('workers', existing);
    return;
  }
  const client = await pool.connect();
  try {
    const res = await client.query(`SELECT id, data FROM workers WHERE farm_id = $1`, [farmId]);
    for (const row of res.rows) {
      if (row.data.disabled) continue;
      const goingOffline = row.data.status !== 'offline';
      if (!goingOffline && !hasStaleReadings(row.data)) continue;
      const updated = { ...row.data, status: 'offline', hashrate: 0, hr_display: '—', temp: null, fan: null };
      await client.query(
        goingOffline
          ? `UPDATE workers SET data=$1, updated_at=NOW() WHERE id=$2`
          : `UPDATE workers SET data=$1 WHERE id=$2`,
        [JSON.stringify(updated), row.id]
      );
    }
  } catch(e) {
    console.error('[DB] clearFarmReadings error:', e.message);
  } finally { client.release(); }
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
    for (const raw of workersList) {
      // Clients push their whole cached fleet here. A cached copy of a
      // machine that has since gone down still carries its last reading,
      // so it is stripped on the way in — see sanitizeWorkerReadings.
      const w = sanitizeWorkerReadings(raw);
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

// ── Hand-entered power per model ──────────────────────────
// Shared fleet-wide on purpose: entering a wattage once should make
// every machine of that model countable, at every site.
function normalizeModelKeyDb(s) {
  // Must stay identical to normalizeModelKey() in the frontend, or a
  // figure saved from the browser would be filed under a key the
  // lookup never asks for. "+" is a model name ("DG1+"), not
  // punctuation, so it becomes a word instead of being dropped.
  return String(s || '').toLowerCase().replace(/\+/g, 'plus').replace(/[^a-z0-9]/g, '');
}

async function loadModelPower() {
  if (useFallback || !pool) {
    return loadFallback('model_power').map(r => ({
      model_key: r.id, watts: r.watts, label: r.label, force: !!r.force, set_by: r.set_by, updated_at: r.updated_at,
    }));
  }
  try {
    const r = await pool.query('SELECT model_key, watts, label, force, set_by, updated_at FROM model_power ORDER BY label');
    return r.rows;
  } catch(e) {
    console.error('[DB] loadModelPower error:', e.message);
    return [];
  }
}

async function saveModelPower(modelKey, watts, label, setBy, force) {
  const key = normalizeModelKeyDb(modelKey);
  if (!key) return false;
  const w = Math.round(Number(watts));
  if (!isFinite(w) || w <= 0) return false;
  const f = !!force;

  if (useFallback || !pool) {
    const all = loadFallback('model_power').filter(r => r.id !== key);
    all.push({ id: key, watts: w, label: label || key, force: f, set_by: setBy || null, updated_at: new Date().toISOString() });
    return saveFallback('model_power', all, true);
  }
  try {
    await pool.query(`
      INSERT INTO model_power(model_key, watts, label, force, set_by)
      VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(model_key) DO UPDATE SET watts=$2, label=$3, force=$4, set_by=$5, updated_at=NOW()
    `, [key, w, label || key, f, setBy || null]);
    return true;
  } catch(e) {
    console.error('[DB] saveModelPower error:', e.message);
    return false;
  }
}

async function deleteModelPower(modelKey) {
  const key = normalizeModelKeyDb(modelKey);
  if (!key) return false;
  if (useFallback || !pool) {
    return saveFallback('model_power', loadFallback('model_power').filter(r => r.id !== key), true);
  }
  try {
    await pool.query('DELETE FROM model_power WHERE model_key=$1', [key]);
    return true;
  } catch(e) {
    console.error('[DB] deleteModelPower error:', e.message);
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
    // Same rule as the database path — an offline machine's record can't
    // carry live readings, whichever store is in use.
    if (key === 'workers' && Array.isArray(data)) data = data.map(sanitizeWorkerReadings);
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

// ── Deletion records ────────────────────────────────────────
// See the deleted_records table comment for why deletions have to be
// written down rather than inferred from something being missing.
const TOMBSTONE_KEEP_DAYS = 90;

async function addTombstone(kind, id) {
  if (!kind || !id) return false;
  if (useFallback || !pool) {
    let store = {};
    if (fs.existsSync(FALLBACK_FILE)) { try { store = JSON.parse(fs.readFileSync(FALLBACK_FILE,'utf8')); } catch(e) { store = {}; } }
    store.deleted_records = (store.deleted_records || []).filter(t => !(t.id === id && t.kind === kind));
    store.deleted_records.push({ id, kind, deleted_at: new Date().toISOString() });
    try { fs.writeFileSync(FALLBACK_FILE, JSON.stringify(store), 'utf8'); return true; } catch(e) { return false; }
  }
  try {
    await pool.query(
      `INSERT INTO deleted_records(id, kind) VALUES($1,$2)
       ON CONFLICT (id, kind) DO UPDATE SET deleted_at = NOW()`,
      [id, kind]
    );
    return true;
  } catch(e) {
    console.error('[DB] addTombstone error:', e.message);
    return false;
  }
}

// Called when something deliberately deleted legitimately comes back —
// a machine that was removed from the fleet but is still plugged in and
// gets rediscovered by the agent's own scan. Without this, the poller
// would keep re-adding it and every device would keep pruning it away.
async function clearTombstone(kind, id) {
  if (!kind || !id) return false;
  if (useFallback || !pool) {
    let store = {};
    if (fs.existsSync(FALLBACK_FILE)) { try { store = JSON.parse(fs.readFileSync(FALLBACK_FILE,'utf8')); } catch(e) { store = {}; } }
    if (!Array.isArray(store.deleted_records)) return true;
    store.deleted_records = store.deleted_records.filter(t => !(t.id === id && t.kind === kind));
    try { fs.writeFileSync(FALLBACK_FILE, JSON.stringify(store), 'utf8'); return true; } catch(e) { return false; }
  }
  try {
    await pool.query('DELETE FROM deleted_records WHERE id=$1 AND kind=$2', [id, kind]);
    return true;
  } catch(e) { return false; }
}

async function loadTombstones() {
  if (useFallback || !pool) {
    const cutoff = Date.now() - TOMBSTONE_KEEP_DAYS * 86400000;
    return loadFallback('deleted_records').filter(t => new Date(t.deleted_at || 0).getTime() >= cutoff);
  }
  try {
    const r = await pool.query(
      `SELECT id, kind, deleted_at FROM deleted_records
        WHERE deleted_at >= NOW() - ($1 || ' days')::interval`,
      [String(TOMBSTONE_KEEP_DAYS)]
    );
    return r.rows;
  } catch(e) {
    console.error('[DB] loadTombstones error:', e.message);
    return [];
  }
}

async function deleteWorker(id) {
  await addTombstone('worker', id);
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

// A machine can end up recorded twice: once under its original identity,
// and again under a fresh one, when it couldn't be recognised as "the
// same machine" on a later poll. That happens whenever BOTH its MAC and
// serial number are unavailable (some firmware never exposes either) —
// its only identity is then its IP, and any IP change (a DHCP renewal
// after a reboot, a router replacement, a whole farm's power coming
// back on at once) makes the poll treat it as brand-new. The old record
// sits there orphaned and offline; a second, freshly-created record
// carries its real current readings under a new id.
//
// This merges the two back into one: KEEP's identity (id, name, customer
// assignment, disabled state, added_at — everything a person set) is
// preserved, and DISCARD's live readings (ip, mac, serial, hashrate,
// temp, status, pool info, etc.) are copied on top, since those are
// what's actually current. DISCARD is then deleted.
const LIVE_WORKER_FIELDS = [
  'ip', 'mac', 'serial', 'model', 'brand', 'algo',
  'hashrate', 'hr_unit', 'hr_display', 'temp', 'fan', 'power', 'uptime',
  'pool', 'worker', 'worker_id', 'pool_status', 'pools',
  'accepted', 'rejected', 'hw_errors', 'boards', 'status', 'source',
  'farm', 'farm_id',
];
async function mergeWorkers(keepId, discardId) {
  if (!keepId || !discardId || keepId === discardId) {
    return { ok: false, error: 'keep_id and discard_id must both be set and different' };
  }
  const [keep, discard] = await Promise.all([getWorkerById(keepId), getWorkerById(discardId)]);
  if (!keep)    return { ok: false, error: 'Machine to keep not found' };
  if (!discard) return { ok: false, error: 'Machine to discard not found' };

  const merged = { ...keep };
  LIVE_WORKER_FIELDS.forEach(f => { if (discard[f] !== undefined) merged[f] = discard[f]; });
  // The discarded record's own id must never leak into the kept one
  merged.id = keep.id;

  const saved = await saveWorkers([merged]); // upsert — touches only this one record
  if (!saved) return { ok: false, error: 'Failed to save merged machine' };
  const deleted = await deleteWorker(discardId);
  if (!deleted) console.error(`[DB] mergeWorkers: merged into ${keepId} but failed to delete duplicate ${discardId} — it will need removing by hand`);
  return { ok: true, worker: merged };
}

async function deleteCustomer(id) {
  await addTombstone('customer', id);
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

// ── Team members (real staff accounts) ──────────────────────
async function loadTeamMembers() {
  if (useFallback || !pool) return loadFallback('team_members');
  try {
    const r = await pool.query('SELECT data FROM team_members ORDER BY updated_at ASC');
    return r.rows.map(row => row.data);
  } catch(e) {
    console.error('[DB] loadTeamMembers error:', e.message);
    return [];
  }
}

async function saveTeamMember(member) {
  if (!member || !member.id) return false;
  if (useFallback || !pool) return saveFallback('team_members', [member]);
  try {
    await pool.query(
      `INSERT INTO team_members(id, data) VALUES($1,$2)
       ON CONFLICT (id) DO UPDATE SET data=$2, updated_at=NOW()`,
      [member.id, JSON.stringify(member)]
    );
    return true;
  } catch(e) {
    console.error('[DB] saveTeamMember error:', e.message);
    return false;
  }
}

async function deleteTeamMember(id) {
  if (useFallback || !pool) {
    let store = {};
    if (fs.existsSync(FALLBACK_FILE)) store = JSON.parse(fs.readFileSync(FALLBACK_FILE,'utf8'));
    if (Array.isArray(store.team_members)) store.team_members = store.team_members.filter(m => m.id !== id);
    try { fs.writeFileSync(FALLBACK_FILE, JSON.stringify(store), 'utf8'); return true; }
    catch(e) { return false; }
  }
  try {
    await pool.query('DELETE FROM team_members WHERE id=$1', [id]);
    return true;
  } catch(e) {
    console.error('[DB] deleteTeamMember error:', e.message);
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

module.exports = { connect, loadModelPower, saveModelPower, deleteModelPower, normalizeModelKeyDb, saveWorkers, loadWorkers, getWorkerById, findWorkerByFarmAndIp, deleteWorker, mergeWorkers, upsertWorkersByIp, clearFarmReadings, saveCustomers, loadCustomers, deleteCustomer, loadTeamMembers, saveTeamMember, deleteTeamMember, addTombstone, clearTombstone, loadTombstones, saveAgentConfig, loadAgentConfig, loadAllAgentConfigs, isUsingDB, accrueEarnings, getEarningsSummary, getEarningsHistory, recordMetrics, pruneMetrics, getWorkerHistory, getUptimeReport };

