// ============================================================
// SITE POWER — server-side copy of the dashboard's "Power by site"
// ------------------------------------------------------------
// Used by the Telegram daily summary. Same rules as the app
// (frontend/app.js minerWatts / computeSitePower), so both show the same
// number:
//   1. a hand-entered model figure marked "force" wins outright;
//   2. else the miner's own reading, when plausible (100–25,000 W);
//   3. else a hand-entered model figure (Settings › power per model);
//   4. else the built-in spec table below;
//   5. else the machine is "not counted" (and the total says how many).
// Only running machines draw power here.
// KEEP POWER_SPECS IN STEP with the table of the same name in app.js.
// ============================================================
const db = require('./db');

const POWER_SPECS = {
  // ── Bitmain, Scrypt (LTC/DOGE) ──
  'antminerl9':          3570,   // 17 Gh/s
  'antminerl7':          3425,   // 9.16 Gh/s
  'antminerl11hyd2u':    5775,   // 35 Gh/s
  'antminerl11hyd6u':    5676,   // 33 Gh/s
  // ── Bitmain, SHA-256 ──
  'antminers21pro':      3510,   // 245 Th/s
  'antminers21xpplushyd': 5500,  // 500 Th/s ("S21 XP+ Hyd")
  'antminers21exphyd3u': 11180,  // 860 Th/s
  'antminers21':         3550,   // 200 Th/s
  'antminers23hyd3u':    11020,  // 1.16 Ph/s
  'antminers23exphyd2u': 8650,   // 865 Th/s
  'antminers23xphyd':    5340,   // 600 Th/s
  'antminers23hyd':      5510,   // 580 Th/s
  'antminers19jproplus': 3355,   // 122 Th/s ("S19j Pro+")
  'antminers19jpro':     3068,   // 104 Th/s
  'antminers19pro':      3250,   // 110 Th/s
  'antminers19xp':       3010,   // 140 Th/s
  // ── Bitmain, other algorithms ──
  'antminerka3':         3154,   // 166 Th/s KHeavyHash
  'antminerz15pro':      2780,
  'antminerz15k':        2483,
  'antminerz15':         1510,
  'antminerz11':         1418,
  'antminerx9':          2472,
  // ── ElphaPEX, Scrypt ──
  'elphapexdg1plus':     3920,   // 14 Gh/s
  'elphapexdghome1':      620,   // 2 Gh/s
  'elphapexdg1':         3420,   // 11 Gh/s
  'dg1plus':             3920,   // firmware often omits the brand
  'dghome1':              620,
  'dg1':                 3420,
  // ── MicroBT ──
  'whatsminerm79s':     20000,
  'whatsminerm50s':      3276,
  'whatsminerm50':       3276,
  // ── Bitdeer SealMiner ──
  'sealminera4ultrahydro': 8372,
  'sealminera4prohydro':   7412,
  'sealminera3prohydro':   8250,
  'sealminerdl1hydro':     7823,
  'sealminerdl1air':       3725,
  'a9zmaster':           1550,
};

const POWER_SPEC_KEYS = Object.keys(POWER_SPECS).sort((a, b) => b.length - a.length);
const PLAUSIBLE_WATTS_MIN = 100, PLAUSIBLE_WATTS_MAX = 25000, MIN_OVERRIDE_KEY_LEN = 3;

function normalizeModelKey(s) { return String(s || '').toLowerCase().replace(/\+/g, 'plus').replace(/[^a-z0-9]/g, ''); }
function modelKeyOf(w) { return normalizeModelKey((w.brand || '') + ' ' + (w.model || '')); }
function specWattsFor(w) {
  const hay = modelKeyOf(w);
  if (!hay) return 0;
  for (const k of POWER_SPEC_KEYS) if (hay.indexOf(k) !== -1) return POWER_SPECS[k];
  return 0;
}
function overrideFor(w, overrides) {
  const key = modelKeyOf(w);
  if (!key || !overrides.length) return null;
  let best = null, bestLen = -1;
  for (const o of overrides) {
    const k = o.model_key;
    if (!k || k.length < MIN_OVERRIDE_KEY_LEN) continue;
    if (k === key) return o;
    if ((key.indexOf(k) !== -1 || k.indexOf(key) !== -1) && k.length > bestLen) { best = o; bestLen = k.length; }
  }
  return best;
}
// Watts for one RUNNING machine + where the figure came from.
function minerWatts(w, overrides) {
  const manual = overrideFor(w, overrides);
  if (manual && manual.force && Number(manual.watts) > 0) return { watts: Number(manual.watts), source: 'manual' };
  const measured = Number(w.power) || 0;
  if (measured >= PLAUSIBLE_WATTS_MIN && measured <= PLAUSIBLE_WATTS_MAX) return { watts: measured, source: 'measured' };
  if (manual && Number(manual.watts) > 0) return { watts: Number(manual.watts), source: 'manual' };
  const spec = specWattsFor(w);
  if (spec > 0) return { watts: spec, source: 'spec' };
  return { watts: 0, source: 'unknown' };
}
// workers: records to count (pass only running ones) → { farm_id: { watts, running, unknown } }
async function bySite(workers) {
  let overrides = [];
  try { overrides = (await db.loadModelPower()) || []; } catch (e) {}
  const out = {};
  workers.forEach(w => {
    if (!w || !w.farm_id) return;
    const f = out[w.farm_id] || (out[w.farm_id] = { watts: 0, running: 0, unknown: 0 });
    const r = minerWatts(w, overrides);
    f.running++; f.watts += r.watts;
    if (r.source === 'unknown') f.unknown++;
  });
  return out;
}
function fmtPower(watts) {
  if (!watts) return '0 kW';
  if (watts >= 1e6) return (watts / 1e6).toFixed(2) + ' MW';
  return (watts / 1000).toFixed(watts >= 100000 ? 0 : 1) + ' kW';
}

module.exports = { bySite, minerWatts, fmtPower, POWER_SPECS };
