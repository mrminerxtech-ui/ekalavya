// ============================================================
// EARNINGS ACCRUAL SERVICE
// ------------------------------------------------------------
// Every 10 minutes this looks at which machines are actually
// hashing, works out what they earned during that slot at the
// live BTC price and network difficulty, and adds it to each
// customer's running total.
//
// WHY A SERVER-SIDE TICK AND NOT A PAGE-VIEW CALCULATION:
//   - Calculated on page view, two people opening the portal
//     would double-count the same period.
//   - And nothing would accrue at all while nobody is looking,
//     which is most of the time.
//   The total has to be a record of observed time, not a
//   function of who happened to open a browser.
//
// WHY 10-MINUTE SLOTS:
//   - A Railway restart loses at most one slot (~0.7% of a day).
//   - Machine downtime is naturally reflected: a machine that's
//     offline for 3 hours simply doesn't earn for those 18 slots.
//   - 144 slots/day keeps the write volume trivial.
//
// WHAT THIS DELIBERATELY DOES NOT DO:
//   - It never backfills missed slots. If the backend was down,
//     that time genuinely wasn't observed, and inventing earnings
//     for it would be fabricating a money figure.
//   - It never accrues when the live price or difficulty is
//     unavailable; the slot is skipped rather than estimated.
//   - These are hashrate-based ESTIMATES, not pool payouts.
// ============================================================
const db = require('./db');
const { getMarket } = require('../routes/market');

const SLOT_MINUTES = 10;
const SLOT_MS      = SLOT_MINUTES * 60 * 1000;
const SLOT_DAYS    = SLOT_MINUTES / (60 * 24); // fraction of a day

// F2Pool's PPS fee for SHA-256. Revenue credited to a customer
// should be what a pool actually pays out, not theoretical gross.
const POOL_FEE_PCT = 2.5;

let timer = null;

// Slot key: the UTC 10-minute bucket. Used to make the accrual
// idempotent — if the service somehow ticks twice inside one slot
// (restart, overlapping timer), the second write is a no-op.
function slotKey(d) {
  const t = new Date(Math.floor(d.getTime() / SLOT_MS) * SLOT_MS);
  return t.toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
}
function dayKey(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD, UTC
}

// SHA-256 (Bitcoin) machines only. A Scrypt/LTC machine's hashrate
// fed into a Bitcoin formula produces a meaningless figure, so those
// are excluded from BTC earnings entirely rather than miscounted.
// This mirrors isShaMiner() in the frontend — keep them in step.
function isShaMiner(w) {
  const algo = (w.algo || '').toLowerCase();
  if (algo) return algo.indexOf('sha') !== -1;
  const unit = (w.hr_unit || '').toUpperCase();
  return unit.indexOf('TH') === 0 || unit.indexOf('PH') === 0;
}

function hashesPerSec(w) {
  const v = Number(w.hashrate) || 0;
  if (v <= 0) return 0;
  const unit = (w.hr_unit || 'TH/s').toUpperCase();
  const mult = unit.indexOf('PH') === 0 ? 1e15
             : unit.indexOf('TH') === 0 ? 1e12
             : unit.indexOf('GH') === 0 ? 1e9
             : unit.indexOf('MH') === 0 ? 1e6
             : 1e12;
  return v * mult;
}

// Standard mining revenue maths, the same basis a pool calculator
// uses: difficulty × 2^32 is the expected number of hashes per block.
function btcForSlot(hps, difficulty, reward) {
  const btcPerSec = (hps * reward) / (difficulty * 4294967296);
  return btcPerSec * 86400 * SLOT_DAYS;
}

async function tick() {
  let market;
  try {
    market = await getMarket();
  } catch (e) {
    console.warn('[EARNINGS] Slot skipped — market data unavailable:', e.message);
    return;
  }

  const price = Number(market.btc_usd);
  const diff  = Number(market.difficulty);
  const rew   = Number(market.block_reward);
  if (!isFinite(price) || price <= 0 || !isFinite(diff) || diff <= 0 || !isFinite(rew) || rew <= 0) {
    console.warn('[EARNINGS] Slot skipped — market figures failed validation');
    return;
  }

  let workers = [], customers = [];
  try {
    workers   = await db.loadWorkers()   || [];
    customers = await db.loadCustomers() || [];
  } catch (e) {
    console.error('[EARNINGS] Slot skipped — could not load fleet:', e.message);
    return;
  }

  const now  = new Date();
  const slot = slotKey(now);
  const day  = dayKey(now);

  // Group the currently-hashing machines by customer.
  const byCustomer = new Map();
  for (const w of workers) {
    if (!w || !w.cid) continue;                 // unassigned — nobody to credit
    if (w.disabled) continue;                   // deliberately switched off
    if ((w.status || 'offline') !== 'online') continue; // not hashing right now
    if (!isShaMiner(w)) continue;               // not earning BTC
    const hps = hashesPerSec(w);
    if (hps <= 0) continue;
    const cur = byCustomer.get(w.cid) || { hps: 0, count: 0 };
    cur.hps  += hps;
    cur.count += 1;
    byCustomer.set(w.cid, cur);
  }

  let credited = 0;
  for (const [cid, agg] of byCustomer) {
    const btc   = btcForSlot(agg.hps, diff, rew);
    const gross = btc * price * (1 - POOL_FEE_PCT / 100);

    // Hosting is charged per machine per month, so this slot's share
    // is that monthly rate spread across the machines that were
    // actually running. A machine that's off isn't billed for that
    // slot, which matches how the customer is really charged.
    const cust  = customers.find(c => c.id === cid);
    const rate  = cust && Number(cust.rate);
    const hosting = (isFinite(rate) && rate > 0)
      ? (rate * agg.count) * (SLOT_DAYS / 30)
      : 0;

    try {
      const wrote = await db.accrueEarnings(cid, day, slot, btc, gross, hosting);
      if (wrote) credited++;
    } catch (e) {
      console.error('[EARNINGS] Accrual failed for customer', cid + ':', e.message);
    }
  }

  if (credited) {
    console.log(`[EARNINGS] Slot ${slot} — credited ${credited} customer(s) at $${Math.round(price)}/BTC`);
  }
}

function start() {
  if (timer) return;
  // Run once shortly after boot so a restart doesn't leave a long
  // gap, then on the slot cadence.
  setTimeout(() => { tick().catch(e => console.error('[EARNINGS]', e.message)); }, 30 * 1000);
  timer = setInterval(() => { tick().catch(e => console.error('[EARNINGS]', e.message)); }, SLOT_MS);
  console.log(`[EARNINGS] Accrual started (every ${SLOT_MINUTES} min)`);
}

function stop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { start, stop, tick, SLOT_MINUTES };
