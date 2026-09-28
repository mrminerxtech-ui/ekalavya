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
//     (default 3). After that it's left alone and Telegram says it needs a
//     person — this also stops a loop on a machine whose hashrate simply
//     can't be read.
//   • After a restart the machine gets `minutes` again (min 15) to boot
//     and start hashing before it can be restarted again.
//   • Site-wide problem: if more than SITE_WIDE_PCT of a site's reachable
//     machines (and at least SITE_WIDE_MIN) are at 0 at once, it's the
//     pool, network or power — rebooting won't help and a mass reboot is
//     a power surge. Nothing is restarted there; Telegram is told once an
//     hour.
//   • At most PER_SITE_PER_TICK reboots per site per minute, so a batch
//     is staggered rather than all at once.
// ============================================================
const agentMgr = require('./agentManager');
const db       = require('./db');

const SETTING_KEY       = 'auto_restart';
const DEFAULTS          = { enabled: false, minutes: 10, max_per_day: 3 };
const TICK_MS           = 60 * 1000;
const MIN_BOOT_GRACE_MS = 15 * 60 * 1000;
const DAY_MS            = 24 * 60 * 60 * 1000;
const SITE_WIDE_PCT     = 0.30;
const SITE_WIDE_MIN     = 8;
const PER_SITE_PER_TICK = 5;
const FORGET_AFTER_MS   = 3 * 60 * 1000;   // gone from polls this long → no longer tracked

let settings = { ...DEFAULTS };
const zero     = new Map();   // "farm|key" -> { farmId, ip, key, since, lastSeen }
const seenAt   = new Map();   // farmId -> Map(key -> { ip, zero:boolean, at }) latest poll per site
const history  = new Map();   // "farm|key" -> [restart timestamps]
const graceTil = new Map();   // "farm|key" -> timestamp; no restart before this
const log      = [];          // recent actions, newest first (for the Settings page)
const siteWarnedAt = new Map();
const gaveUpNotified = new Map();

function keyOf(m) {
  const mac = m.mac ? String(m.mac).toUpperCase().replace(/[^0-9A-F]/g, '') : '';
  return mac.length === 12 ? 'mac:' + mac : 'ip:' + m.ip;
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
function getLog() { return log.slice(0, 50); }

let telegram = null;   // set in start() — alerts.js requires agentManager too, so resolved lazily
function tell(text) { try { telegram && telegram(text, 'warn'); } catch (e) {} }

async function tick() {
  await loadSettings();
  const now = Date.now();
  // forget machines that stopped appearing in polls (unreachable, moved)
  zero.forEach((e, k) => { if (now - e.lastSeen > FORGET_AFTER_MS) zero.delete(k); });
  if (!settings.enabled) return;

  const agents = new Map(agentMgr.getAgents().map(a => [a.farm_id, a]));
  const waitMs = settings.minutes * 60 * 1000;
  const due = [...zero.entries()].filter(([, e]) => now - e.since >= waitMs);
  if (!due.length) return;

  const workers = await db.loadWorkers();
  const recFor = (farmId, e) => workers.find(w => w && w.farm_id === farmId &&
    (e.key.startsWith('mac:') ? String(w.mac || '').toUpperCase().replace(/[^0-9A-F]/g, '') === e.key.slice(4) : w.ip === e.ip))
    || workers.find(w => w && w.farm_id === farmId && w.ip === e.ip);

  const bySite = new Map();
  due.forEach(([k, e]) => { if (!bySite.has(e.farmId)) bySite.set(e.farmId, []); bySite.get(e.farmId).push([k, e]); });

  for (const [farmId, list] of bySite) {
    const agent = agents.get(farmId);
    if (!agent) continue;                                   // agent disconnected — can't reach anything
    const siteName = agent.farm_name || farmId;

    // Site-wide problem?
    const site = seenAt.get(farmId) || new Map();
    const reachable = site.size, zeroNow = [...site.values()].filter(s => s.zero).length;
    if (zeroNow >= SITE_WIDE_MIN && zeroNow > reachable * SITE_WIDE_PCT) {
      if (!siteWarnedAt.get(farmId) || now - siteWarnedAt.get(farmId) > 60 * 60 * 1000) {
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
    const restarted = [], gaveUp = [];
    for (const [k, e] of list) {
      if (sent >= PER_SITE_PER_TICK) break;
      if ((graceTil.get(k) || 0) > now) continue;
      const w = recFor(farmId, e);
      const label = w ? `${w.name || w.ip} (${e.ip})` : e.ip;
      if (w && w.disabled) continue;                         // in repair
      if (w && w.last_action === 'sleep') continue;          // put to sleep on purpose
      const recent = (history.get(k) || []).filter(t => now - t < DAY_MS);
      history.set(k, recent);
      if (recent.length >= settings.max_per_day) {
        if (!gaveUpNotified.get(k) || now - gaveUpNotified.get(k) > DAY_MS) {
          gaveUpNotified.set(k, now);
          gaveUp.push(label);
          note({ site: siteName, machine: label, action: 'gave-up', detail: `${recent.length} automatic restarts in 24h` });
        }
        continue;
      }
      sent++;
      const mins = Math.round((now - e.since) / 60000);
      let result;
      try { result = await agentMgr.sendActionRequest(farmId, e.ip, 'reboot', { brand: w && w.brand, model: w && w.model }); }
      catch (err) { result = { ok: false, error: err.message }; }
      recent.push(now); history.set(k, recent);
      graceTil.set(k, now + Math.max(waitMs, MIN_BOOT_GRACE_MS));
      e.since = now;                                          // needs another full wait before counting again
      if (result && result.ok) {
        console.log(`[AUTO-RESTART] ✓ ${siteName}: rebooted ${label} — 0 hashrate for ${mins} min (restart ${recent.length}/${settings.max_per_day} today)`);
        note({ site: siteName, machine: label, action: 'restarted', detail: `0 hashrate for ${mins} min · ${recent.length}/${settings.max_per_day} today` });
        restarted.push(`${label} (${mins} min at 0)`);
      } else {
        const why = (result && result.error) || 'no reply';
        console.log(`[AUTO-RESTART] ✗ ${siteName}: reboot of ${label} failed — ${why}`);
        note({ site: siteName, machine: label, action: 'failed', detail: why });
      }
    }
    if (restarted.length) tell(`Auto-restart at ${siteName}: rebooted ${restarted.length} machine(s) at 0 hashrate for ${settings.minutes}+ min: ${restarted.join(', ')}`);
    if (gaveUp.length) tell(`Auto-restart at ${siteName}: still at 0 hashrate after ${settings.max_per_day} automatic restarts today — needs a person: ${gaveUp.join(', ')}`);
  }
}

let timer = null, running = false;
function start() {
  if (timer) return;
  try { telegram = require('./alerts').sendTelegramAlert; } catch (e) {}
  loadSettings().then(s => console.log(`[AUTO-RESTART] ${s.enabled ? 'ON' : 'off'} — ${s.minutes} min at 0 hashrate, max ${s.max_per_day}/machine/day (change in Settings)`));
  timer = setInterval(() => {
    if (running) return;
    running = true;
    tick().catch(e => console.error('[AUTO-RESTART]', e.message)).finally(() => { running = false; });
  }, TICK_MS);
}

module.exports = { start, tick, observePoll, getSettings, saveSettings, loadSettings, getLog,
                   _state: { zero, history, graceTil, seenAt } };
