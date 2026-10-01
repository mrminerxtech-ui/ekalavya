// ============================================================
// TELEGRAM ALERT RULES — what goes to the group, set in Settings
// ------------------------------------------------------------
// The group only gets farm-level news. Besides the site alarm (N+
// machines offline / farm PC unreachable — alerts.js, Settings › Site
// Alarm) these rules can be switched on/off and tuned in Settings ›
// Telegram Alerts:
//
//   🔥 overheat   — M or more running machines at one site at or above T °C
//   📉 hashdrop   — running machines at one site make P % less than usual
//                   (machines that went offline don't count here: that's
//                   the site alarm's job — this catches dead boards,
//                   throttling, a bad pool on a few machines …)
//   ✅ recovery   — one message when a problem above (or the site alarm)
//                   is over
//   🗓 summary    — one status message a day at a set time (Dubai time)
//   📄 autorestart_log    — the log post after a machine's last restart
//   ⏸ autorestart_paused  — "a whole site is at 0 hashrate" warning
//
// Every problem is confirmed on two checks in a row (checks every 3 min),
// sent once, and repeated only if it gets clearly WORSE. State is kept on
// the server (app_settings `telegram_rules_state`) so a redeploy neither
// repeats an alert nor loses its "back to normal" message.
// Settings: app_settings `telegram_rules`.
// ============================================================
const db = require('./db');

const RULES_KEY = 'telegram_rules';
const STATE_KEY = 'telegram_rules_state';
const CHECK_EVERY_MS = 3 * 60 * 1000;
const TZ = 'Asia/Dubai';

const DEFAULTS = {
  overheat:           { on: true,  temp: 90, min: 3 },
  hashdrop:           { on: true,  pct: 15 },
  recovery:           { on: true },
  summary:            { on: false, time: '09:00' },
  autorestart_log:    { on: true },
  autorestart_paused: { on: true },
};
const OVERHEAT_WORSE_BY = 3;      // machines more than when last sent → send again
const HASHDROP_WORSE_BY = 10;     // percentage points more than when last sent → send again
const HASHDROP_CLEAR_FRACTION = 0.5;   // clears when the drop is back under half the limit
const BASELINE_TAU_MS = 3 * 60 * 60 * 1000;   // "usual" hashrate = average over roughly the last 3 h
const BASELINE_MIN_SAMPLES = 20;  // ≈ 1 h of checks before a machine counts
const HASHDROP_MAX_ACTIVE_MS = 24 * 60 * 60 * 1000;   // after a day the lower level becomes the new normal
const MIN_MACHINES_FOR_DROP = 3;

let rules = clone(DEFAULTS);
let rulesAt = 0;
function clone(o) { return JSON.parse(JSON.stringify(o)); }
const int = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= lo && n <= hi ? n : d; };

function sanitize(v) {
  const out = clone(DEFAULTS);
  if (!v || typeof v !== 'object') return out;
  for (const k of Object.keys(DEFAULTS)) if (v[k] && typeof v[k] === 'object' && 'on' in v[k]) out[k].on = !!v[k].on;
  if (v.overheat) { out.overheat.temp = int(v.overheat.temp, 50, 150, DEFAULTS.overheat.temp); out.overheat.min = int(v.overheat.min, 1, 1000, DEFAULTS.overheat.min); }
  if (v.hashdrop) out.hashdrop.pct = int(v.hashdrop.pct, 5, 90, DEFAULTS.hashdrop.pct);
  if (v.summary && /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v.summary.time || ''))) out.summary.time = v.summary.time;
  return out;
}
function validate(v) {
  if (!v || typeof v !== 'object') return 'Nothing to save';
  if (v.overheat) {
    const t = parseInt(v.overheat.temp, 10), m = parseInt(v.overheat.min, 10);
    if (!(t >= 50 && t <= 150)) return 'Overheating temperature must be between 50 and 150 °C';
    if (!(m >= 1 && m <= 1000)) return 'Overheating: number of machines must be at least 1';
  }
  if (v.hashdrop) { const p = parseInt(v.hashdrop.pct, 10); if (!(p >= 5 && p <= 90)) return 'Hashrate drop must be between 5 and 90 %'; }
  if (v.summary && v.summary.time !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v.summary.time))) return 'Daily summary time must be like 09:00';
  return null;
}
async function loadRules(force) {
  if (!force && Date.now() - rulesAt < 30 * 1000) return rules;
  try { const v = await db.getSetting(RULES_KEY); rules = sanitize(v); rulesAt = Date.now(); } catch (e) {}
  return rules;
}
async function saveRules(v, by) {
  const err = validate(v); if (err) return { ok: false, error: err };
  const next = sanitize({ ...rules, ...v });
  if (!(await db.setSetting(RULES_KEY, next, by))) return { ok: false, error: 'Could not save' };
  const was = rules; rules = next; rulesAt = Date.now();
  const diff = Object.keys(next).filter(k => JSON.stringify(was[k]) !== JSON.stringify(next[k]))
    .map(k => `${k} ${next[k].on ? 'ON' : 'off'}${k === 'overheat' ? ` (${next[k].min}+ at ${next[k].temp}°C)` : k === 'hashdrop' ? ` (${next[k].pct}%)` : k === 'summary' ? ` (${next[k].time})` : ''}`);
  console.log(`[TG-RULES] Changed by ${by || '?'}: ${diff.join(', ') || 'no change'}`);
  return { ok: true, rules: next };
}
// Synchronous check used by other services (auto-restart). Uses the last loaded rules.
function isOn(key) { return !!(rules[key] && rules[key].on); }
function getRules() { return rules; }
function telegramConfigured() { return !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID); }

// ── Sending ────────────────────────────────────────────────────────
let sender = null;   // (text, level, title) — alerts.sendTelegramAlert, resolved lazily (circular require)
function send(title, text) {
  try {
    const fn = sender || require('./alerts').sendTelegramAlert;
    return Promise.resolve(fn(text, 'plain', title)).catch(() => {});
  } catch (e) { return Promise.resolve(); }
}

// ── State ──────────────────────────────────────────────────────────
// st.overheat[farm] = { active, since, sentCount, pending }   pending = count seen at the previous check
// st.hashdrop[farm|unit] = { active, since, sentPct, pending }
// st.summaryDate = 'YYYY-MM-DD' (Dubai) last sent
let st = { overheat: {}, hashdrop: {}, summaryDate: null };
const baseline = new Map();   // worker id -> { ema (H/s), n, at }
let stateLoaded = false, stateDirty = false, baseSavedAt = 0;
async function loadState() {
  if (stateLoaded) return;
  try {
    const v = await db.getSetting(STATE_KEY);
    if (v && typeof v === 'object') {
      st.overheat = v.overheat || {}; st.hashdrop = v.hashdrop || {}; st.summaryDate = v.summaryDate || null;
      Object.entries(v.baseline || {}).forEach(([id, b]) => { if (Array.isArray(b) && Number.isFinite(b[0])) baseline.set(id, { ema: b[0], n: b[1] || 0, at: b[2] || 0 }); });
    }
    stateLoaded = true;
  } catch (e) {}
}
function saveState(force) {
  const now = Date.now();
  if (!stateDirty && !(force || now - baseSavedAt > 15 * 60 * 1000)) return;
  stateDirty = false; baseSavedAt = now;
  const b = {};
  baseline.forEach((v, id) => { if (now - v.at < 2 * 24 * 60 * 60 * 1000) b[id] = [Math.round(v.ema), v.n, v.at]; });
  try { Promise.resolve(db.setSetting(STATE_KEY, { overheat: st.overheat, hashdrop: st.hashdrop, summaryDate: st.summaryDate, baseline: b }, 'alert-rules')).catch(() => {}); } catch (e) {}
}

// ── Helpers ────────────────────────────────────────────────────────
const UNIT = { 'h/s': 1, 'kh/s': 1e3, 'mh/s': 1e6, 'gh/s': 1e9, 'th/s': 1e12, 'ph/s': 1e15, 'eh/s': 1e18 };
function unitOf(w) { const u = String(w.hr_unit || 'TH/s').trim().toLowerCase(); return UNIT[u] ? u : 'th/s'; }
function toBase(w) { return (Number(w.hashrate) || 0) * UNIT[unitOf(w)]; }
function fmtRate(hs, unitKey) {
  // show in the group's own unit, stepped up when large (12,000 TH/s → 12.0 PH/s)
  const order = ['h/s', 'kh/s', 'mh/s', 'gh/s', 'th/s', 'ph/s', 'eh/s'];
  let i = order.indexOf(unitKey); if (i < 0) i = 4;
  let v = hs / UNIT[order[i]];
  while (v >= 1000 && i < order.length - 1) { i++; v /= 1000; }
  const lbl = order[i].toUpperCase().replace('/S', '/s');
  return (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + ' ' + lbl;
}
const running = w => w && !w.disabled && (w.status === 'online' || w.status === 'warn') && w.last_action !== 'sleep';
const label = w => (w.name && w.name !== w.ip ? `${w.name} (${w.ip || '?'})` : (w.ip || w.id || '?'));
function farmNameMap(workers, agents) {
  const m = {};
  workers.forEach(w => { const f = w.farm_id; if (f && w.farm && !m[f]) m[f] = w.farm; });
  (agents || []).forEach(a => { if (a.farm_id && a.farm_name) m[a.farm_id] = a.farm_name; });
  return m;
}
function dubaiNow(now) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date(now)).reduce((o, x) => (o[x.type] = x.value, o), {});
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: (+p.hour % 24) * 60 + (+p.minute), pretty: `${p.day}/${p.month}` };
}
const lasted = since => { const m = Math.max(1, Math.round((Date.now() - since) / 60000)); return m < 90 ? `${m} min` : `${(m / 60).toFixed(1)} h`; };

// ── Rule: overheating ─────────────────────────────────────────────
async function checkOverheat(workers, names) {
  const r = rules.overheat;
  const byFarm = {};
  workers.forEach(w => {
    if (!running(w) || !w.farm_id) return;
    const t = Number(w.temp);
    if (!(t > 0 && t < 200)) return;
    (byFarm[w.farm_id] = byFarm[w.farm_id] || []);
    if (t >= r.temp) byFarm[w.farm_id].push(w);
  });
  const farms = new Set([...Object.keys(byFarm), ...Object.keys(st.overheat)]);
  for (const fid of farms) {
    const hot = (byFarm[fid] || []).sort((a, b) => Number(b.temp) - Number(a.temp));
    const s = st.overheat[fid] || (st.overheat[fid] = { active: false });
    const over = r.on && hot.length >= r.min;
    if (over) {
      const before = s.pending; s.pending = hot.length; s.clearPending = null; stateDirty = true;
      if (before === undefined || before === null) continue;            // confirm on the next check
      const confirmed = Math.min(before, hot.length);
      if (confirmed < r.min) continue;
      if (s.active && confirmed < (s.sentCount || 0) + OVERHEAT_WORSE_BY) { if (confirmed < (s.sentCount || 0)) s.sentCount = confirmed; continue; }
      const worse = s.active;
      if (!s.active) { s.active = true; s.since = Date.now(); }
      s.sentCount = confirmed; s.clearPending = null;
      const list = hot.slice(0, 10).map(w => `${label(w)} ${Math.round(Number(w.temp))} °C`).join('\n') + (hot.length > 10 ? `\n… +${hot.length - 10} more` : '');
      console.log(`[TG-RULES] ${names[fid] || fid}: ${confirmed} machine(s) at ${r.temp}°C+ — ${worse ? 'worse, sending again' : 'sending'}`);
      await send(`🔥 Overheating${worse ? ' — getting worse' : ''} — ${confirmed} machine${confirmed === 1 ? '' : 's'} at ${r.temp} °C or more`,
        `Farm : ${names[fid] || fid}\n${list}`);
    } else {
      s.pending = null;
      if (s.active) {
        // two checks below the limit before calling it over
        if (!s.clearPending) { s.clearPending = Date.now(); stateDirty = true; continue; }
        const since = s.since;
        st.overheat[fid] = { active: false }; stateDirty = true;
        console.log(`[TG-RULES] ${names[fid] || fid}: overheating over`);
        if (rules.recovery.on && r.on) await send('✅ Overheating over', `Farm : ${names[fid] || fid}\n${hot.length ? hot.length + ' machine(s) still at ' + r.temp + ' °C+ (below the limit of ' + r.min + ')' : 'No machine at ' + r.temp + ' °C or more'} · lasted ${lasted(since)}`);
      } else if (!byFarm[fid] || !byFarm[fid].length) delete st.overheat[fid];
    }
  }
}

// ── Rule: hashrate drop on running machines ───────────────────────
function updateBaselines(workers, frozenFarmUnits, now) {
  workers.forEach(w => {
    if (!w || !w.id) return;
    if (!running(w) || !(Number(w.hashrate) > 0)) return;
    if (frozenFarmUnits.has(w.farm_id + '|' + unitOf(w))) return;   // keep "usual" as it was while a drop is active
    const x = toBase(w), b = baseline.get(w.id);
    if (!b) { baseline.set(w.id, { ema: x, n: 1, at: now }); return; }
    // A sudden fall (dead board, throttling) must not drag "usual" down with
    // it; only if a machine stays that low for a day is it its new normal.
    if (b.n >= BASELINE_MIN_SAMPLES && x < b.ema * 0.85) {
      if (!b.lowSince) b.lowSince = now;
      if (now - b.lowSince < HASHDROP_MAX_ACTIVE_MS) { b.at = now; return; }
    } else b.lowSince = 0;
    const a = 1 - Math.exp(-Math.max(0, now - b.at) / BASELINE_TAU_MS);
    b.ema = b.ema + Math.min(1, Math.max(a, 1 / (b.n + 1))) * (x - b.ema);   // quick start, then ~3 h memory
    b.n++; b.at = now;
  });
}
async function checkHashdrop(workers, names, now) {
  const r = rules.hashdrop;
  const groups = {};   // farm|unit -> { cur, base, n, machines:[] }
  workers.forEach(w => {
    if (!running(w) || !w.farm_id || !w.id) return;
    const b = baseline.get(w.id);
    if (!b || b.n < BASELINE_MIN_SAMPLES || !(b.ema > 0)) return;
    const key = w.farm_id + '|' + unitOf(w);
    const g = groups[key] || (groups[key] = { fid: w.farm_id, unit: unitOf(w), cur: 0, base: 0, n: 0, machines: [] });
    const x = toBase(w);
    g.cur += x; g.base += b.ema; g.n++;
    if (x < b.ema * 0.9) g.machines.push({ w, x, b: b.ema });
  });
  const keys = new Set([...Object.keys(groups), ...Object.keys(st.hashdrop)]);
  for (const key of keys) {
    const g = groups[key];
    const s = st.hashdrop[key] || (st.hashdrop[key] = { active: false });
    const fid = key.split('|')[0], name = names[fid] || fid;
    if (!g || g.n < MIN_MACHINES_FOR_DROP || !(g.base > 0)) { s.pending = null; if (!s.active) delete st.hashdrop[key]; continue; }
    const drop = Math.max(0, Math.round((1 - g.cur / g.base) * 100));
    if (s.active && now - (s.since || now) > HASHDROP_MAX_ACTIVE_MS) {
      console.log(`[TG-RULES] ${name}: hashrate ${drop}% below the old normal for 24 h — taking it as the new normal`);
      st.hashdrop[key] = { active: false }; stateDirty = true; continue;
    }
    if (r.on && drop >= r.pct) {
      const before = s.pending; s.pending = drop; s.clearPending = null; stateDirty = true;
      if (before === undefined || before === null) continue;
      const confirmed = Math.min(before, drop);
      if (confirmed < r.pct) continue;
      if (s.active && confirmed < (s.sentPct || 0) + HASHDROP_WORSE_BY) continue;
      const worse = s.active;
      if (!s.active) { s.active = true; s.since = now; }
      s.sentPct = confirmed; s.clearPending = null;
      const top = g.machines.sort((a, b) => (b.b - b.x) - (a.b - a.x)).slice(0, 6)
        .map(m => `${label(m.w)} ${fmtRate(m.b, g.unit)} → ${fmtRate(m.x, g.unit)}`).join('\n');
      console.log(`[TG-RULES] ${name}: running machines ${confirmed}% below usual — ${worse ? 'worse, sending again' : 'sending'}`);
      await send(`📉 Hashrate drop${worse ? ' — getting worse' : ''} — running machines ${confirmed}% below usual`,
        `Farm : ${name}\nNow ${fmtRate(g.cur, g.unit)} · usual ${fmtRate(g.base, g.unit)} (${g.n} machines running)` + (top ? `\nMost down:\n${top}` : ''));
    } else {
      s.pending = null;
      if (s.active) {
        if (drop >= r.pct * HASHDROP_CLEAR_FRACTION && r.on) { s.clearPending = null; continue; }   // not clearly better yet
        if (!s.clearPending) { s.clearPending = now; stateDirty = true; continue; }
        const since = s.since;
        st.hashdrop[key] = { active: false }; stateDirty = true;
        console.log(`[TG-RULES] ${name}: hashrate back to normal`);
        if (rules.recovery.on && r.on) await send('✅ Hashrate back to normal', `Farm : ${name}\nNow ${fmtRate(g.cur, g.unit)} · usual ${fmtRate(g.base, g.unit)} · lasted ${lasted(since)}`);
      } else delete st.hashdrop[key];
    }
  }
}

// ── Recovery of the site alarm (called by alerts.js) ──────────────
async function siteRecovered(farmName, info) {
  await loadRules();
  if (!rules.recovery.on) return;
  await send('✅ Site back to normal', `Farm : ${farmName}\n${info}`);
}

// ── Daily summary ─────────────────────────────────────────────────
async function buildSummary(workers, names) {
  let counts = {};
  try { counts = require('./alerts').countPhysicalMachines(workers) || {}; } catch (e) {}
  const farms = Object.keys(names).filter(f => f && f !== 'unassigned').sort((a, b) => String(names[a]).localeCompare(String(names[b])));
  const lines = farms.map(fid => {
    const ws = workers.filter(w => w && w.farm_id === fid);
    const c = counts[fid] || { total: ws.filter(w => !w.disabled).length, offline: ws.filter(w => !w.disabled && !running(w)).length };
    const repair = ws.filter(w => w.disabled).length;
    const byUnit = {};
    ws.filter(running).forEach(w => { const u = unitOf(w); byUnit[u] = (byUnit[u] || 0) + toBase(w); });
    const rate = Object.entries(byUnit).filter(([, v]) => v > 0).map(([u, v]) => fmtRate(v, u)).join(' + ') || '—';
    const hottest = ws.filter(running).reduce((m, w) => Math.max(m, Number(w.temp) > 0 && Number(w.temp) < 200 ? Number(w.temp) : 0), 0);
    return `${names[fid]}: ${c.total - c.offline}/${c.total} online · ${rate}` + (repair ? ` · ${repair} in repair` : '') + (hottest ? ` · hottest ${Math.round(hottest)} °C` : '');
  });
  let ar = '';
  try {
    const s = require('./autorestart').summary();
    if (s) ar = `\nAuto-restart, last 24 h: ${s.restarts24h} restart${s.restarts24h === 1 ? '' : 's'}` + (s.leftForPerson ? ` · ${s.leftForPerson} machine${s.leftForPerson === 1 ? '' : 's'} left for a person` : '');
  } catch (e) {}
  const open = [];
  Object.entries(st.overheat).forEach(([fid, s]) => { if (s.active) open.push(`🔥 ${names[fid] || fid} overheating`); });
  Object.entries(st.hashdrop).forEach(([k, s]) => { if (s.active) open.push(`📉 ${names[k.split('|')[0]] || k} hashrate ${s.sentPct}% down`); });
  return lines.join('\n') + ar + (open.length ? '\nStill open: ' + open.join(' · ') : '');
}
async function checkSummary(workers, names, now) {
  const r = rules.summary;
  if (!r.on) return;
  const d = dubaiNow(now);
  const [hh, mm] = r.time.split(':').map(Number), at = hh * 60 + mm;
  if (st.summaryDate === d.date) return;
  if (d.minutes < at || d.minutes > at + 60) return;          // only within the hour after the set time
  st.summaryDate = d.date; stateDirty = true; saveState(true);
  console.log(`[TG-RULES] Daily summary (${d.date} ${r.time} Dubai)`);
  await send(`🗓 Daily summary — ${d.pretty}`, await buildSummary(workers, names));
}

// ── The check ─────────────────────────────────────────────────────
let checking = false;
async function check(now = Date.now()) {
  if (checking) return; checking = true;
  try {
    await Promise.all([loadRules(), loadState()]);
    const workers = (await db.loadWorkers()).filter(Boolean);
    let agents = [];
    try { agents = require('./agentManager').getAgents(); } catch (e) {}
    const names = farmNameMap(workers, agents);
    const online = new Set(agents.map(a => a.farm_id));
    // A farm whose agent is gone shows everything offline/stale — the site
    // alarm covers that; don't judge its temperatures or hashrate.
    const live = workers.filter(w => online.has(w.farm_id));
    const frozen = new Set(Object.entries(st.hashdrop).filter(([, s]) => s.active).map(([k]) => k));
    updateBaselines(live, frozen, now);
    await checkOverheat(live, names);
    await checkHashdrop(live, names, now);
    await checkSummary(workers, names, now);
    saveState();
  } catch (e) { console.error('[TG-RULES]', e.message); }
  finally { checking = false; }
}

async function sendTest(by) {
  if (!telegramConfigured()) return { ok: false, error: 'Telegram is not set up on the server (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)' };
  await loadRules();
  const on = [];
  if (rules.overheat.on) on.push(`🔥 ${rules.overheat.min}+ machines at ${rules.overheat.temp} °C`);
  if (rules.hashdrop.on) on.push(`📉 hashrate ${rules.hashdrop.pct}% below usual`);
  if (rules.recovery.on) on.push('✅ back-to-normal messages');
  if (rules.summary.on) on.push(`🗓 daily summary at ${rules.summary.time}`);
  if (rules.autorestart_log.on) on.push('📄 log after the last automatic restart');
  if (rules.autorestart_paused.on) on.push('⏸ auto-restart paused (site-wide 0 hashrate)');
  let alarmAt = null;
  try { alarmAt = require('./alerts').getAlarmSettings().alarm_at; } catch (e) {}
  await send('✅ Test message — Ekalavya alerts', `Sent from Settings by ${by || '?'}.\nThis group gets:\n🚨 site down: ${alarmAt || '?'}+ machines offline or farm PC unreachable\n` + on.join('\n'));
  return { ok: true };
}

let timer = null;
function start() {
  if (timer) return;
  loadRules(true).then(r => console.log(`[TG-RULES] overheat ${r.overheat.on ? `ON (${r.overheat.min}+ at ${r.overheat.temp}°C)` : 'off'} · hashrate drop ${r.hashdrop.on ? `ON (${r.hashdrop.pct}%)` : 'off'} · recovery ${r.recovery.on ? 'ON' : 'off'} · daily summary ${r.summary.on ? `ON (${r.summary.time} Dubai)` : 'off'} — change in Settings › Telegram Alerts`));
  timer = setInterval(() => check().catch(() => {}), CHECK_EVERY_MS);
  setTimeout(() => check().catch(() => {}), 20 * 1000);
}

module.exports = { start, check, loadRules, saveRules, getRules, isOn, siteRecovered, sendTest, telegramConfigured, buildSummary,
                   DEFAULTS, _state: () => st, _baseline: baseline, _setSender: fn => { sender = fn; }, _reset: () => { st = { overheat: {}, hashdrop: {}, summaryDate: null }; baseline.clear(); stateLoaded = false; rulesAt = 0; } };
