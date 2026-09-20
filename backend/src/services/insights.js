// ============================================================
// INSIGHTS — metric history + underperformer detection
// ------------------------------------------------------------
// Two jobs:
//
//   1. Every 10 minutes, write a snapshot of every miner to
//      miner_metrics. Without stored history the software can only
//      answer "what is true right now" — never "when did this break",
//      "what is this machine's uptime", or "has it been degrading".
//
//   2. Find machines that are running but underperforming. A dead
//      miner is obvious and gets fixed the same day. A miner quietly
//      producing 70% of what it should is invisible, and loses money
//      for weeks — often more money in total than the dead one.
//
// HOW "UNDERPERFORMING" IS DECIDED:
//   Against the MEDIAN OF ITS OWN MODEL in your fleet, not against a
//   published spec sheet. A table of rated hashrates goes stale, is
//   wrong for custom firmware, and is wrong again if you underclock —
//   and it can't know that your L11s all run a little under spec by
//   design. The fleet's own machines are the honest benchmark: if
//   fourteen L11s sit at 20.8 GH/s and one sits at 14.2, that one has
//   a problem, whatever any spec sheet claims.
//
//   The median is used rather than the mean so that a couple of badly
//   broken machines can't drag the benchmark down and hide themselves.
// ============================================================
const db = require('./db');

const SLOT_MINUTES   = 10;
const SLOT_MS        = SLOT_MINUTES * 60 * 1000;
const RETENTION_DAYS = 30;

// A cohort needs enough machines for a median to mean anything. Below
// this, there's no trustworthy benchmark and the model is skipped
// rather than guessed at.
const MIN_COHORT = 3;

// How far below the cohort median counts as a problem. 15% is wide
// enough to ignore normal variation between units and narrow enough to
// catch a genuinely failing hashboard (a dead board on a 3-board miner
// costs ~33%).
const UNDERPERFORM_PCT = 15;

let collectTimer = null, pruneTimer = null;

function slotStart(d) {
  return new Date(Math.floor(d.getTime() / SLOT_MS) * SLOT_MS);
}

// Normalise to TH/s so one column can hold every machine. Comparisons
// are always within a single model, so the absolute scale doesn't
// matter — only that it's consistent.
function toTh(w) {
  const v = Number(w.hashrate) || 0;
  if (v <= 0) return 0;
  const unit = (w.hr_unit || 'TH/s').toUpperCase();
  const mult = unit.indexOf('PH') === 0 ? 1e3
             : unit.indexOf('TH') === 0 ? 1
             : unit.indexOf('GH') === 0 ? 1e-3
             : unit.indexOf('MH') === 0 ? 1e-6
             : 1;
  return v * mult;
}

// Model is what defines a cohort, so it has to be normalised — "S21 Pro",
// "s21  pro" and "Antminer S21 Pro" are one model, not three cohorts of
// one machine each (which would disable detection entirely).
function modelKey(w) {
  const raw = ((w.brand || '') + ' ' + (w.model || '')).toLowerCase();
  const cleaned = raw
    .replace(/antminer|bitmain|whatsminer|microbt|avalon|canaan|sealminer|bitdeer/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return cleaned || null;
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ── 1. History collection ───────────────────────────────────
async function collect() {
  let workers = [];
  try {
    workers = await db.loadWorkers() || [];
  } catch (e) {
    console.error('[INSIGHTS] Snapshot skipped — could not load fleet:', e.message);
    return;
  }
  if (!workers.length) return;

  const slot = slotStart(new Date()).toISOString();
  const rows = workers
    .filter(w => w && w.id && !w.disabled)   // a switched-off machine isn't downtime
    .map(w => ({
      worker_id:   w.id,
      farm_id:     w.farm_id || null,
      status:      w.status || 'offline',
      hashrate_th: toTh(w),
      temp:        Number(w.temp) > 0 ? Number(w.temp) : null,
      fan:         Number(w.fan)  > 0 ? Math.round(Number(w.fan)) : null,
      model:       modelKey(w),
    }));

  try {
    const n = await db.recordMetrics(slot, rows);
    if (n) console.log(`[INSIGHTS] Snapshot ${slot} — ${n} miners recorded`);
  } catch (e) {
    console.error('[INSIGHTS] recordMetrics failed:', e.message);
  }
}

async function prune() {
  try {
    const n = await db.pruneMetrics(RETENTION_DAYS);
    if (n) console.log(`[INSIGHTS] Pruned ${n} metric rows older than ${RETENTION_DAYS} days`);
  } catch (e) {
    console.error('[INSIGHTS] prune failed:', e.message);
  }
}

// ── 2. Underperformer detection ─────────────────────────────
//
// Uses averaged history rather than the current instant, because a
// single reading dips for entirely innocent reasons — a pool
// switch, a restart, a momentary poll miss. A machine is only called
// underperforming if it has been so for hours.
async function findUnderperformers(opts) {
  const hours    = Math.min(Math.max(parseInt((opts && opts.hours), 10) || 6, 1), 24 * 7);
  const days     = Math.max(1, Math.ceil(hours / 24));
  const farmId   = (opts && opts.farmId) || null;
  const threshold = Number((opts && opts.thresholdPct)) || UNDERPERFORM_PCT;

  const [report, workers] = await Promise.all([
    db.getUptimeReport(days, farmId),
    db.loadWorkers().catch(() => []),
  ]);

  const byId = new Map((workers || []).map(w => [w.id, w]));

  // Only machines that were actually running are judged. An offline
  // machine isn't "underperforming" — it's offline, which is a
  // different problem with a different fix.
  const candidates = report
    .filter(r => Number(r.avg_hashrate_th) > 0 && Number(r.slots_online) > 0)
    .map(r => {
      const w = byId.get(r.worker_id) || {};
      return {
        worker_id: r.worker_id,
        name:      w.name || w.ip || r.worker_id,
        ip:        w.ip || null,
        farm_id:   r.farm_id || w.farm_id || null,
        model:     r.model || modelKey(w),
        brand:     w.brand || null,
        model_raw: w.model || null,
        hr_unit:   w.hr_unit || 'TH/s',
        avg_th:    Number(r.avg_hashrate_th),
        avg_temp:  r.avg_temp != null ? Number(r.avg_temp) : null,
        uptime_pct: r.uptime_pct != null ? Number(r.uptime_pct) : null,
        slots_online: Number(r.slots_online),
      };
    })
    .filter(c => c.model);

  // Group into cohorts by model
  const cohorts = new Map();
  candidates.forEach(c => {
    if (!cohorts.has(c.model)) cohorts.set(c.model, []);
    cohorts.get(c.model).push(c);
  });

  const flagged = [];
  const skipped = [];

  for (const [model, members] of cohorts) {
    if (members.length < MIN_COHORT) {
      skipped.push({ model, count: members.length, reason: `only ${members.length} machine(s) of this model — no reliable benchmark` });
      continue;
    }
    const benchmark = median(members.map(m => m.avg_th));
    if (!benchmark || benchmark <= 0) continue;

    members.forEach(m => {
      const pctOfPeers = 100 * m.avg_th / benchmark;
      const shortfall  = 100 - pctOfPeers;
      if (shortfall >= threshold) {
        flagged.push({
          ...m,
          peer_median_th: benchmark,
          pct_of_peers:   Math.round(pctOfPeers * 10) / 10,
          shortfall_pct:  Math.round(shortfall * 10) / 10,
          cohort_size:    members.length,
        });
      }
    });
  }

  // Worst first — that's the order someone will work through them in.
  flagged.sort((a, b) => b.shortfall_pct - a.shortfall_pct);

  return {
    window_hours: hours,
    threshold_pct: threshold,
    checked: candidates.length,
    cohorts: cohorts.size,
    flagged,
    skipped_models: skipped,
  };
}

function start() {
  if (collectTimer) return;
  // First snapshot shortly after boot so a restart doesn't leave a gap,
  // then on the slot cadence.
  setTimeout(() => { collect().catch(e => console.error('[INSIGHTS]', e.message)); }, 20 * 1000);
  collectTimer = setInterval(() => { collect().catch(e => console.error('[INSIGHTS]', e.message)); }, SLOT_MS);
  pruneTimer   = setInterval(() => { prune().catch(e => console.error('[INSIGHTS]', e.message)); }, 24 * 60 * 60 * 1000);
  console.log(`[INSIGHTS] History collection started (every ${SLOT_MINUTES} min, kept ${RETENTION_DAYS} days)`);
}

function stop() {
  if (collectTimer) { clearInterval(collectTimer); collectTimer = null; }
  if (pruneTimer)   { clearInterval(pruneTimer);   pruneTimer   = null; }
}

module.exports = { start, stop, collect, prune, findUnderperformers, modelKey, toTh, median, MIN_COHORT, UNDERPERFORM_PCT };
