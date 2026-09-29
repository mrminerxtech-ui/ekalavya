// ============================================================
// AUTO-RESTART — reboot machines that are reachable but not hashing
// ------------------------------------------------------------
// A machine the farm agent can still reach, but which reports 0 hashrate
// for N minutes in a row (default 10, set on the Settings page), is sent
// the same reboot the Manage panel's Reboot button sends. A machine that
// doesn't answer at all (no power / no network) isn't in the poll, so
// can't be restarted remotely and isn't counted here.
//
// OFF until switched on in Settings. Safety rules, because this reboots
// real hardware on its own:
//   • Never touches: machines in repair (disabled), machines put to sleep
//     (last action = sleep), machines whose farm agent is disconnected.
//   • At most `max_per_day` automatic restarts per machine per 24h
//     (default 3). After that it's left alone — this also stops a loop on
//     a machine whose hashrate simply can't be read. Individual restarts
//     are NOT posted to Telegram (the group was flooded); the group hears
//     about a machine once: its log, 10 min after its last restart.
//   • After a restart the machine gets `minutes` again (min 15) to boot
//     and start hashing before it can be restarted again.
//   • Site-wide problem: if more than SITE_WIDE_PCT of a site's reachable
//     machines (and at least SITE_WIDE_MIN) are at 0 at once, it's the
//     pool, network or power — rebooting won't help and a mass reboot is
//     a power surge. Nothing is restarted there; Telegram is told once,
//     then every 6 h while it lasts.
//   • At most PER_SITE_PER_TICK reboots per site per minute, so a batch
//     is staggered rather than all at once.
//
// PER MACHINE: each machine can override the default from its own page
// (Workers → machine → Auto-restart) or in bulk from the Workers list:
//   • default — follows the switch/minutes/cap above
//   • off     — never restarted automatically (e.g. hydro machines)
//   • on      — restarted with its OWN minutes and daily cap, even while
//               the default is off
// Stored in app_settings key `auto_restart_machines`, keyed by MAC (or the
// record id when there's no MAC) so it survives IP changes. All the safety
// rules above apply to every machine whatever its setting.
// ============================================================
const agentMgr = require('./agentManager');
const db       = require('./db');

const SETTING_KEY       = 'auto_restart';
const MACHINES_KEY      = 'auto_restart_machines';
const DEFAULTS          = { enabled: false, minutes: 10, max_per_day: 3 };
const TICK_MS           = 60 * 1000;
const MIN_BOOT_GRACE_MS = 15 * 60 * 1000;
const DAY_MS            = 24 * 60 * 60 * 1000;
const SITE_WIDE_PCT     = 0.30;
const SITE_WIDE_MIN     = 8;
const PER_SITE_PER_TICK = 5;
const FORGET_AFTER_MS   = 3 * 60 * 1000;   // gone from polls this long → no longer tracked

let settings = { ...DEFAULTS };
let overrides = {};           // machineKey -> { mode:'on'|'off', minutes, max_per_day, worker_id, name, ip, farm_id, set_by, set_at }
const zero     = new Map();   // "farm|key" -> { farmId, ip, key, since, lastSeen }
const seenAt   = new Map();   // farmId -> Map(key -> { ip, zero:boolean, at }) latest poll per site
const history  = new Map();   // "farm|key" -> [restart timestamps]
const graceTil = new Map();   // "farm|key" -> timestamp; no restart before this
const log      = [];          // recent actions, newest first (for the Settings page)
const siteWarnedAt = new Map();
const gaveUpNotified = new Map();
// After a machine's LAST allowed automatic restart of the day, its log is
// fetched LOG_AFTER_MS later and posted to the Telegram group as a .txt
// file, so someone can see why it keeps failing without logging in.
const LOG_AFTER_MS      = 10 * 60 * 1000;
const LOG_GIVE_UP_MS    = 30 * 60 * 1000;     // agent offline this long past due → post without the log
const logJobs = new Map();                    // "farm|key" -> { farmId, siteName, workerId, ip, due, restarts, lastAt }

function keyOf(m) {
  const mac = m.mac ? String(m.mac).toUpperCase().replace(/[^0-9A-F]/g, '') : '';
  return mac.length === 12 ? 'mac:' + mac : 'ip:' + m.ip;
}
function normMac(v) {
  const mac = v ? String(v).toUpperCase().replace(/[^0-9A-F]/g, '') : '';
  return mac.length === 12 ? mac : '';
}
// Key a per-machine setting is stored under: MAC when known, else record id.
function machineKey(rec) { const mac = normMac(rec && rec.mac); return mac ? 'mac:' + mac : 'id:' + (rec && rec.id); }
// Key the poll tracker uses for this record (poll results carry MAC or IP).
function pollKey(rec) { const mac = normMac(rec && rec.mac); return mac ? 'mac:' + mac : 'ip:' + (rec && rec.ip); }
function overrideFor(rec) {
  if (!rec) return null;
  const mac = normMac(rec.mac);
  return (mac && overrides['mac:' + mac]) || overrides['id:' + rec.id] || null;
}
// What applies to this machine right now: null = not restarted automatically.
function effectiveFor(rec) {
  const ov = overrideFor(rec);
  if (ov && ov.mode === 'off') return null;
  if (ov && ov.mode === 'on') return { minutes: ov.minutes, max_per_day: ov.max_per_day, own: true, from: Date.parse(ov.set_at) || 0 };
  if (!settings.enabled) return null;
  return { minutes: settings.minutes, max_per_day: settings.max_per_day, own: false, from: 0 };
}
function isZero(m) { return !(Number(m.hashrate) > 0); }
function note(entry) {
  log.unshift({ at: new Date().toISOString(), ...entry });
  if (log.length > 100) log.length = 100;
}

// Called for every poll result (agentManager). Tracks how long each
// reachable machine has been at 0 hashrate.
function observePoll(farmId, miners) {
  if (!Array.isArray(miners)) return;
  const now = Date.now();
  const site = new Map();
  for (const m of miners) {
    if (!m || !m.ip) continue;
    const key = keyOf(m), k = farmId + '|' + key, z = isZero(m);
    site.set(key, { ip: m.ip, zero: z, at: now });
    if (z) {
      const e = zero.get(k);
      if (e) { e.ip = m.ip; e.lastSeen = now; }
      else zero.set(k, { farmId, ip: m.ip, key, since: now, lastSeen: now });
    } else {
      zero.delete(k);
    }
  }
  seenAt.set(farmId, site);
}

async function loadSettings() {
  try {
    const v = await db.getSetting(SETTING_KEY);
    if (v && typeof v === 'object') settings = sanitize({ ...DEFAULTS, ...v });
  } catch (e) { /* keep current */ }
  return settings;
}
async function loadOverrides() {
  try {
    const v = await db.getSetting(MACHINES_KEY);
    if (v && typeof v === 'object' && !Array.isArray(v)) overrides = v;
  } catch (e) { /* keep current */ }
  return overrides;
}
function sanitize(v) {
  const minutes = parseInt(v.minutes, 10), max = parseInt(v.max_per_day, 10);
  return {
    enabled: !!v.enabled,
    minutes: minutes >= 5 && minutes <= 1440 ? minutes : DEFAULTS.minutes,
    max_per_day: max >= 1 && max <= 20 ? max : DEFAULTS.max_per_day,
  };
}
function validate(v) {
  const minutes = parseInt(v.minutes, 10), max = parseInt(v.max_per_day, 10);
  if (!(minutes >= 5 && minutes <= 1440)) return 'Minutes at zero hashrate must be between 5 and 1440';
  if (!(max >= 1 && max <= 20)) return 'Restarts per machine per day must be between 1 and 20';
  return null;
}
function getSettings() { return { ...settings, defaults: DEFAULTS }; }
async function saveSettings(v, by) {
  const err = validate(v || {});
  if (err) return { ok: false, error: err };
  const next = sanitize({ ...settings, ...v });
  if (!(await db.setSetting(SETTING_KEY, next, by))) return { ok: false, error: 'Could not save the setting' };
  const was = settings; settings = next;
  console.log(`[AUTO-RESTART] Settings changed${by ? ' by ' + by : ''}: ${was.enabled ? 'on' : 'off'} → ${next.enabled ? 'ON' : 'off'}, ` +
              `${next.minutes} min at 0 hashrate, max ${next.max_per_day}/machine/day`);
  if (!was.enabled && next.enabled) {
    // Start counting from now — a machine that happened to be at 0 for an
    // hour while this was off shouldn't be rebooted the instant it's on.
    const now = Date.now();
    zero.forEach(e => { e.since = Math.max(e.since, now); });
  }
  return { ok: true, ...getSettings() };
}
// ── Per-machine settings ──────────────────────────────────────────
function listOverrides() {
  return Object.entries(overrides).map(([key, o]) => ({ key, ...o }))
    .sort((a, b) => String(a.farm_id).localeCompare(String(b.farm_id)) || String(a.name).localeCompare(String(b.name)));
}
async function getMachine(workerId) {
  await Promise.all([loadSettings(), loadOverrides()]);
  const rec = (await db.loadWorkers()).find(w => w && w.id === workerId);
  if (!rec) return { ok: false, error: 'Machine not found' };
  const ov = overrideFor(rec), eff = effectiveFor(rec), now = Date.now();
  const pk = rec.farm_id + '|' + pollKey(rec);
  const z = zero.get(pk);
  return {
    ok: true,
    mode: ov ? ov.mode : 'default',
    minutes: ov && ov.mode === 'on' ? ov.minutes : settings.minutes,
    max_per_day: ov && ov.mode === 'on' ? ov.max_per_day : settings.max_per_day,
    set_by: ov ? ov.set_by : null, set_at: ov ? ov.set_at : null,
    default: { enabled: settings.enabled, minutes: settings.minutes, max_per_day: settings.max_per_day },
    active: !!eff,
    restarts_today: (history.get(pk) || []).filter(t => now - t < DAY_MS).length,
    zero_minutes: z ? Math.floor((now - z.since) / 60000) : null,
  };
}
// Set one or many machines: mode 'default' (remove own setting), 'off', or
// 'on' with minutes + max_per_day.
let writing = Promise.resolve();
function setMachines(workerIds, v, by) {
  const run = async () => {
    const ids = [...new Set((Array.isArray(workerIds) ? workerIds : [workerIds]).filter(Boolean).map(String))];
    if (!ids.length) return { ok: false, error: 'No machines selected' };
    if (ids.length > 2000) return { ok: false, error: 'Too many machines in one go' };
    const mode = String((v && v.mode) || '');
    if (!['default', 'off', 'on'].includes(mode)) return { ok: false, error: 'Choose default, off or on' };
    if (mode === 'on') { const err = validate(v); if (err) return { ok: false, error: err }; }
    await loadOverrides();
    const all = await db.loadWorkers();
    const byId = new Map(all.filter(Boolean).map(w => [w.id, w]));
    const next = { ...overrides }, changed = [], missing = [];
    const at = new Date(Date.now()).toISOString();
    for (const id of ids) {
      const rec = byId.get(id);
      if (!rec) {
        // record gone (deleted/merged) — still let its own setting be cleared
        const stale = mode === 'default' ? Object.keys(next).filter(k => next[k] && next[k].worker_id === id) : [];
        if (stale.length) { stale.forEach(k => { changed.push(next[k].name || id); delete next[k]; }); continue; }
        missing.push(id); continue;
      }
      // drop any older entry for this machine under its other key
      const mac = normMac(rec.mac);
      if (mac) delete next['id:' + rec.id];
      delete next[machineKey(rec)];
      if (mode !== 'default') {
        next[machineKey(rec)] = {
          mode, worker_id: rec.id, name: rec.name || rec.ip, ip: rec.ip, farm_id: rec.farm_id,
          ...(mode === 'on' ? { minutes: parseInt(v.minutes, 10), max_per_day: parseInt(v.max_per_day, 10) } : {}),
          set_by: by || null, set_at: at,
        };
      }
      changed.push(rec.name || rec.ip);
    }
    if (!changed.length) return { ok: false, error: 'Machine not found' };
    if (!(await db.setSetting(MACHINES_KEY, next, by))) return { ok: false, error: 'Could not save the setting' };
    overrides = next;
    const what = mode === 'default' ? 'back to the default' : mode === 'off' ? 'OFF' : `ON (${v.minutes} min, max ${v.max_per_day}/day)`;
    console.log(`[AUTO-RESTART] ${changed.length} machine(s) set ${what}${by ? ' by ' + by : ''}: ` +
                changed.slice(0, 20).join(', ') + (changed.length > 20 ? ` +${changed.length - 20} more` : ''));
    return { ok: true, updated: changed.length, missing: missing.length, mode };
  };
  const p = writing.then(run, run);
  writing = p.catch(() => {});
  return p;
}
function getLog() { return log.slice(0, 50); }

let telegram = null;   // set in start() — alerts.js requires agentManager too, so resolved lazily
// A message with its own title carries its own icon, so no level emoji in front
let telegramDoc = null;   // alerts.sendTelegramDocument, set in start()

function modelOf(w) {
  if (!w) return null;
  const brand = String(w.brand || '').trim(), model = String(w.model || '').trim();
  if (!model) return brand || null;
  return brand && !model.toLowerCase().includes(brand.toLowerCase()) ? brand + ' ' + model : model;
}
// Farm : / Customer: / Model: / Worker: / IP:  — the layout for the log post
function logCard(siteName, w, ip, customers) {
  const card = machineCard(siteName, w, ip, customers).split('\n');   // Farm, Customer, Worker, Sl.no, IP
  const clean = v => (v === undefined || v === null || String(v).trim() === '' || String(v).trim() === '—') ? '—' : String(v).trim();
  return [card[0], card[1], 'Model: ' + clean(modelOf(w)), card[2], card[4]].join('\n');
}
function stamp(d) {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes());
}

// Post due logs. Runs every tick, whatever the on/off setting — a job
// only exists because a restart already happened.
async function runLogJobs(now) {
  if (!logJobs.size) return;
  const due = [...logJobs.entries()].filter(([, j]) => now >= j.due);
  if (!due.length) return;
  const workers = await db.loadWorkers().catch(() => []);
  let customers = null;
  for (const [k, j] of due) {
    const w = workers.find(x => x && x.id === j.workerId) || null;
    const ip = (w && w.ip) || j.ip;                       // the IP may have changed after the reboot
    const agentUp = agentMgr.getAgents().some(a => a.farm_id === j.farmId);
    if (!agentUp && now - j.due < LOG_GIVE_UP_MS) continue;   // try again next minute
    logJobs.delete(k);
    if (!customers) customers = await db.loadCustomers().catch(() => []);
    const status = zero.has(k) ? 'still at 0 hashrate'
                 : (w && w.status === 'offline') ? 'offline since the restart'
                 : (w && Number(w.hashrate) > 0) ? 'hashing again' : 'still at 0 hashrate';
    const title = `📄 Log after ${j.restarts} automatic restarts today — ${status}`;
    const card = logCard(j.siteName, w, ip, customers);
    let result;
    if (!agentUp) result = { ok: false, error: 'farm agent offline' };
    else {
      try { result = await agentMgr.sendActionRequest(j.farmId, ip, 'downloadlogs', { brand: w && w.brand, model: w && w.model }); }
      catch (e) { result = { ok: false, error: e.message }; }
    }
    const label = w ? `${w.name || ip} (${ip})` : ip;
    if (result && result.ok && result.logs) {
      const header = [
        'Ekalavya — miner log', card, '',
        'Serial: ' + ((w && w.serial) || '—'),
        'Automatic restarts today: ' + j.restarts + ' (last at ' + new Date(j.lastAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC)',
        'Status when fetched: ' + status,
        'Fetched: ' + new Date(now).toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
        '', '─'.repeat(60), '',
      ].join('\n');
      const text = header + String(result.logs).slice(-4 * 1024 * 1024);   // last 4 MB is plenty
      const fname = `${j.siteName}_${(w && (w.worker_id && w.worker_id !== '—' ? w.worker_id : w.name)) || ip}_${stamp(new Date(now))}.txt`;
      const sent = telegramDoc ? await telegramDoc(card, title, fname, text) : { ok: false, error: 'Telegram not ready' };
      console.log(`[AUTO-RESTART] ${sent.ok ? '✓' : '✗'} ${j.siteName}: log of ${label} ${sent.ok ? 'posted to Telegram' : 'not posted — ' + sent.error} (${String(result.logs).length} chars)`);
      note({ site: j.siteName, machine: label, action: sent.ok ? 'log-sent' : 'failed', detail: sent.ok ? 'log posted to Telegram' : 'log not posted: ' + sent.error });
      if (!sent.ok && sent.error !== 'Telegram not configured') tell(card + '\n\nLog could not be sent: ' + sent.error, title);
    } else {
      const why = (result && result.error) || 'the miner sent no log';
      console.log(`[AUTO-RESTART] ✗ ${j.siteName}: log of ${label} could not be fetched — ${why}`);
      note({ site: j.siteName, machine: label, action: 'failed', detail: 'log not fetched: ' + why });
      tell(card + '\n\nLog could not be fetched: ' + why, title);
    }
  }
}

function tell(text, title) { try { telegram && telegram(text, title ? 'plain' : 'warn', title); } catch (e) {} }

// One Telegram message per machine, in the layout the team uses:
//   Farm : / Customer: / Worker: / Sl.no: / IP:
function machineCard(siteName, w, ip, customers) {
  const clean = v => (v === undefined || v === null || String(v).trim() === '' || String(v).trim() === '—') ? '—' : String(v).trim();
  let cust = null;
  if (w) {
    cust = (customers || []).find(c => c && w.cid != null && String(c.id) === String(w.cid))
        || (customers || []).find(c => c && Array.isArray(c.miners) && c.miners.includes(w.id));
  }
  const worker = w ? (clean(w.worker_id) !== '—' ? w.worker_id : clean(w.worker) !== '—' ? w.worker : w.name) : null;
  return [
    'Farm : ' + clean(siteName),
    'Customer: ' + clean(cust && cust.name),
    'Worker: ' + clean(worker),
    'Sl.no: ' + clean(w && w.serial),
    'IP: ' + clean(ip),
  ].join('\n');
}

async function tick() {
  await Promise.all([loadSettings(), loadOverrides()]);
  const now = Date.now();
  try { await runLogJobs(now); } catch (e) { console.error('[AUTO-RESTART] log job error:', e.message); }
  // forget machines that stopped appearing in polls (unreachable, moved)
  zero.forEach((e, k) => { if (now - e.lastSeen > FORGET_AFTER_MS) zero.delete(k); });

  // Anything switched on at all? The default, or at least one machine's own setting.
  const ownOn = Object.values(overrides).filter(o => o && o.mode === 'on');
  if (!settings.enabled && !ownOn.length) return;
  const shortest = Math.min(settings.enabled ? settings.minutes : Infinity, ...ownOn.map(o => o.minutes));
  const candidates = [...zero.entries()].filter(([, e]) => now - e.since >= shortest * 60 * 1000);
  if (!candidates.length) return;

  const agents = new Map(agentMgr.getAgents().map(a => [a.farm_id, a]));
  const workers = await db.loadWorkers();
  const recFor = (farmId, e) => workers.find(w => w && w.farm_id === farmId &&
    (e.key.startsWith('mac:') ? normMac(w.mac) === e.key.slice(4) : w.ip === e.ip))
    || workers.find(w => w && w.farm_id === farmId && w.ip === e.ip);

  // Which of them are due under the setting that applies to that machine?
  const bySite = new Map();
  for (const [k, e] of candidates) {
    const w = recFor(e.farmId, e);
    const cfg = effectiveFor(w);
    if (!cfg) continue;                                     // off for this machine (or default off)
    const since = Math.max(e.since, cfg.from);              // own setting counts from when it was set
    if (now - since < cfg.minutes * 60 * 1000) continue;
    if (!bySite.has(e.farmId)) bySite.set(e.farmId, []);
    bySite.get(e.farmId).push({ k, e, w, cfg, since });
  }

  for (const [farmId, list] of bySite) {
    const agent = agents.get(farmId);
    if (!agent) continue;                                   // agent disconnected — can't reach anything
    const siteName = agent.farm_name || farmId;

    // Site-wide problem?
    const site = seenAt.get(farmId) || new Map();
    const reachable = site.size, zeroNow = [...site.values()].filter(s => s.zero).length;
    if (zeroNow >= SITE_WIDE_MIN && zeroNow > reachable * SITE_WIDE_PCT) {
      if (!siteWarnedAt.get(farmId) || now - siteWarnedAt.get(farmId) > 6 * 60 * 60 * 1000) {   // group: once, then every 6 h while it lasts
        siteWarnedAt.set(farmId, now);
        const msg = `${siteName}: ${zeroNow} of ${reachable} reachable machines are at 0 hashrate at once — ` +
                    `this looks like a pool, network or power problem, so they are NOT being restarted automatically.`;
        console.log('[AUTO-RESTART] ' + msg);
        note({ site: siteName, action: 'skipped-site', detail: `${zeroNow}/${reachable} at 0 hashrate` });
        tell('Auto-restart paused: ' + msg);
      }
      continue;
    }

    let sent = 0;
    for (const { k, e, w, cfg, since } of list) {
      if (sent >= PER_SITE_PER_TICK) break;
      if ((graceTil.get(k) || 0) > now) continue;
      const label = w ? `${w.name || w.ip} (${e.ip})` : e.ip;
      if (w && w.disabled) continue;                         // in repair
      if (w && w.last_action === 'sleep') continue;          // put to sleep on purpose
      const recent = (history.get(k) || []).filter(t => now - t < DAY_MS);
      history.set(k, recent);
      if (recent.length >= cfg.max_per_day) {
        if (!gaveUpNotified.get(k) || now - gaveUpNotified.get(k) > DAY_MS) {
          gaveUpNotified.set(k, now);
          note({ site: siteName, machine: label, action: 'gave-up', detail: `${recent.length} automatic restarts in 24h` });
        }
        continue;
      }
      sent++;
      const mins = Math.round((now - since) / 60000);
      const own = cfg.own ? ' · own setting' : '';
      let result;
      try { result = await agentMgr.sendActionRequest(farmId, e.ip, 'reboot', { brand: w && w.brand, model: w && w.model }); }
      catch (err) { result = { ok: false, error: err.message }; }
      recent.push(now); history.set(k, recent);
      graceTil.set(k, now + Math.max(cfg.minutes * 60 * 1000, MIN_BOOT_GRACE_MS));
      e.since = now;                                          // needs another full wait before counting again
      if (result && result.ok) {
        console.log(`[AUTO-RESTART] ✓ ${siteName}: rebooted ${label} — 0 hashrate for ${mins} min (restart ${recent.length}/${cfg.max_per_day} today${own})`);
        note({ site: siteName, machine: label, action: 'restarted', detail: `0 hashrate for ${mins} min · ${recent.length}/${cfg.max_per_day} today${own}` });
      } else {
        const why = (result && result.error) || 'no reply';
        console.log(`[AUTO-RESTART] ✗ ${siteName}: reboot of ${label} failed — ${why}`);
        note({ site: siteName, machine: label, action: 'failed', detail: why });
      }
      // Its last restart for today (even one that failed) → the one group
      // message about this machine: its log, 10 minutes from now.
      if (recent.length >= cfg.max_per_day && w) {
        logJobs.set(k, { farmId, siteName, workerId: w.id, ip: e.ip, due: now + LOG_AFTER_MS, restarts: recent.length, lastAt: now });
        console.log(`[AUTO-RESTART] ${siteName}: ${label} used its last restart for today — its log goes to Telegram in ${LOG_AFTER_MS / 60000} min`);
      }
    }
    // No Telegram message per restart: the group only hears about a machine
    // once, when it has used its last restart (the log post, 10 min later).
    // Every restart is still listed under Settings › Auto-restart › recent actions.
  }
}

let timer = null, running = false;
function start() {
  if (timer) return;
  try { telegram = require('./alerts').sendTelegramAlert; telegramDoc = require('./alerts').sendTelegramDocument; } catch (e) {}
  Promise.all([loadSettings(), loadOverrides()]).then(([s, o]) => {
    const vals = Object.values(o), on = vals.filter(x => x.mode === 'on').length, off = vals.filter(x => x.mode === 'off').length;
    console.log(`[AUTO-RESTART] default ${s.enabled ? 'ON' : 'off'} — ${s.minutes} min at 0 hashrate, max ${s.max_per_day}/machine/day` +
                (vals.length ? `; own setting on ${vals.length} machine(s): ${on} on, ${off} off` : '') + ' (change in Settings or on a machine\'s page)');
  });
  timer = setInterval(() => {
    if (running) return;
    running = true;
    tick().catch(e => console.error('[AUTO-RESTART]', e.message)).finally(() => { running = false; });
  }, TICK_MS);
}

module.exports = { start, tick, observePoll, getSettings, saveSettings, loadSettings, getLog,
                   loadOverrides, listOverrides, getMachine, setMachines,
                   _state: { zero, history, graceTil, seenAt, logJobs } };
