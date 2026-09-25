// ============================================================
// AUTO DEDUPE — finds and merges duplicate machine records on its own
// ------------------------------------------------------------
// Same job as the "Find & Merge Duplicates" button, run by the server
// every 10 minutes instead of waiting for someone to press it.
//
// How a duplicate happens: a machine's IP changes (DHCP after a reboot or
// a site-wide power cut) and the poller can't recognise it at the new
// address, so it creates a second record. The old one sits there offline
// forever; the new one carries the live readings but has lost the
// customer assignment, name and history.
//
// Merging the wrong pair deletes a real machine, so this is deliberately
// stricter than the button. Records are only merged when ALL of these hold:
//
//   1. They share a hardware ID (MAC or serial), or — weaker — the same
//      pool worker ID in a group of at most 3 records. (Plenty of sites
//      give every miner the same worker name; a group bigger than 3 is
//      that, not a duplicate.)
//   2. They don't CONTRADICT each other: two records that both have a MAC
//      (or both a serial) and the values differ are two machines.
//   3. Exactly ONE record in the group is online right now. Two online at
//      once = two machines. None online = nothing to prove which is which;
//      wait until the machine is back.
//   4. The offline copy has been dark for at least 20 minutes — not a
//      one-poll flicker.
//   5. History proves they were never live at the same time: not a single
//      10-minute slot where both were recorded hashing.
//   6. The live record appeared around or after the old one went dark —
//      the "vanished here, reappeared there" signature. This is what stops
//      a site-wide outage from merging a shared-worker-name fleet: the
//      first machine back has been around for weeks, it didn't appear
//      after the others went dark.
//   7. No disabled record in the group, and no two different customers
//      assigned within it (that needs a human to decide).
//
// What survives: the record with the customer assignment (or, failing
// that, the oldest one) keeps its id, name, customer and history; the
// live record's current IP/status/readings are laid over it; the rest
// are deleted, their history moved across. See db.applyAutoMerge.
// ============================================================
const db = require('./db');

const RUN_EVERY_MS          = 10 * 60 * 1000;
const FIRST_RUN_DELAY_MS    = 5 * 60 * 1000;   // let DB connect + first polls land
const STALE_MIN_MS          = 20 * 60 * 1000;  // rule 4
const REAPPEAR_SLACK_MS     = 20 * 60 * 1000;  // rule 6 tolerance (two metric slots)
const WORKER_ID_MAX_GROUP   = 3;               // rule 1, weak-key cap

const isLive = w => w && (w.status === 'online' || w.status === 'warn');

function normMac(v) {
  if (!v) return null;
  const h = String(v).toUpperCase().replace(/[^0-9A-F]/g, '');
  if (h.length !== 12) return null;
  if (/^0+$/.test(h) || /^F+$/.test(h)) return null;   // factory placeholders
  return h;
}
function normSerial(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (s.length < 4 || /^(—|-|0+|unknown|none|null|n\/a)$/i.test(s)) return null;
  return s;
}
function normWid(v) {
  if (!v) return null;
  const s = String(v).trim();
  return (s && s !== '—') ? s : null;
}

// Rule 2
function contradicts(a, b) {
  const ma = normMac(a.mac), mb = normMac(b.mac);
  if (ma && mb && ma !== mb) return true;
  const sa = normSerial(a.serial), sb = normSerial(b.serial);
  if (sa && sb && sa !== sb) return true;
  return false;
}

// Groups records that share a hardware ID (union-find, so A~B by MAC and
// B~C by serial end up as one group), then groups the remaining
// singletons by worker ID.
function buildGroups(workers) {
  const parent = new Map();
  const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  workers.forEach(w => parent.set(w.id, w.id));

  const firstByKey = new Map();
  workers.forEach(w => {
    [['mac', normMac(w.mac)], ['sn', normSerial(w.serial)]].forEach(([kind, v]) => {
      if (!v) return;
      const k = kind + ':' + v;
      if (firstByKey.has(k)) union(w.id, firstByKey.get(k)); else firstByKey.set(k, w.id);
    });
  });

  const comps = new Map();
  workers.forEach(w => { const r = find(w.id); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(w); });
  const groups = [];
  const inHwGroup = new Set();
  comps.forEach(members => {
    if (members.length < 2) return;
    members.forEach(m => inHwGroup.add(m.id));
    groups.push({ members, basis: 'MAC/serial' });
  });

  const byWid = new Map();
  workers.forEach(w => {
    if (inHwGroup.has(w.id)) return;
    const wid = normWid(w.worker_id);
    if (!wid) return;
    if (!byWid.has(wid)) byWid.set(wid, []);
    byWid.get(wid).push(w);
  });
  byWid.forEach((members, wid) => {
    if (members.length < 2 || members.length > WORKER_ID_MAX_GROUP) return;
    groups.push({ members, basis: 'worker ID "' + wid + '"' });
  });
  return groups;
}

const label = w => `${w.name || w.id} (${w.ip || 'no ip'}${w.farm_id ? ' @ ' + w.farm_id : ''})`;
const ts = v => v ? new Date(v).getTime() : null;

async function evaluateGroup(group) {
  const { members, basis } = group;
  if (members.some(w => w.disabled)) return { skip: 'contains a disabled machine' };

  const live = members.filter(isLive);
  if (live.length === 0) return { skip: 'none online right now — waiting until one is' };
  if (live.length > 1)  return { skip: `${live.length} online at once — different machines` };
  const liveRec = live[0];

  const ids = members.map(w => w.id);
  const meta = await db.getWorkerActivityMeta(ids);
  if (!meta) return { skip: 'could not read history' };
  const now = Date.now();
  const liveFirst = ts(meta[liveRec.id] && meta[liveRec.id].first_seen);

  const accepted = [];
  const rejected = [];
  for (const w of members) {
    if (w.id === liveRec.id) continue;
    if (contradicts(w, liveRec)) { rejected.push(`${label(w)}: different MAC/serial`); continue; }
    const lastOn = ts(meta[w.id] && meta[w.id].last_online);
    // A worker-ID match is only a name someone typed in, so it needs the
    // timing evidence of rule 6 to go with it. A copy with no recorded
    // online time at all (dark for longer than history is kept) can't
    // provide that — it could just as well be a long-dead machine that
    // happened to share the worker name.
    if (!lastOn && group.basis !== 'MAC/serial') { rejected.push(`${label(w)}: no recent history to match timing against`); continue; }
    if (lastOn && now - lastOn < STALE_MIN_MS) { rejected.push(`${label(w)}: was online ${Math.round((now - lastOn) / 60000)}m ago`); continue; }
    if (lastOn && liveFirst && liveFirst < lastOn - REAPPEAR_SLACK_MS) {
      rejected.push(`${label(w)}: both have long histories — the live one existed before this went dark`);
      continue;
    }
    const overlap = await db.countOnlineOverlap(w.id, liveRec.id);
    if (overlap === null) { rejected.push(`${label(w)}: could not check history overlap`); continue; }
    if (overlap > 0) { rejected.push(`${label(w)}: both recorded hashing in ${overlap} of the same slots`); continue; }
    accepted.push(w);
  }
  if (!accepted.length) return { skip: rejected.join('; ') || 'nothing mergeable' };

  // Rule 7 — customers
  const chosen = [liveRec].concat(accepted);
  const cids = Array.from(new Set(chosen.map(w => w.cid).filter(Boolean)));
  if (cids.length > 1) return { skip: `assigned to ${cids.length} different customers — needs a person to decide` };

  // Keeper: the one with the customer, else the oldest record.
  const added = w => { const t = ts(w.added_at); return t === null ? 0 : t; };   // no date = legacy = oldest
  const keeper = chosen.slice().sort((a, b) => {
    const ac = a.cid ? 1 : 0, bc = b.cid ? 1 : 0;
    if (ac !== bc) return bc - ac;
    return added(a) - added(b);
  })[0];

  return {
    keeperId: keeper.id,
    liveId: liveRec.id,
    removeIds: chosen.filter(w => w.id !== keeper.id).map(w => w.id),
    basis,
    describe: `${chosen.filter(w => w.id !== liveRec.id).map(label).join(', ')} ↔ live ${label(liveRec)}`,
    rejected,
  };
}

let running = false;
async function runOnce() {
  const summary = { merged: [], skipped: [] };
  if (running) { summary.skipped.push({ reason: 'a run is already in progress' }); return summary; }
  if (!db.isUsingDB()) { summary.skipped.push({ reason: 'no database — auto-merge needs metric history' }); return summary; }
  running = true;
  try {
    const workers = (await db.loadWorkers()).filter(w => w && w.id);
    const groups = buildGroups(workers);
    for (const g of groups) {
      const d = await evaluateGroup(g);
      if (d.skip) {
        summary.skipped.push({ ids: g.members.map(w => w.id), basis: g.basis, reason: d.skip });
        continue;
      }
      const res = await db.applyAutoMerge(d.keeperId, d.liveId, d.removeIds);
      if (res.ok) {
        console.log(`[DEDUPE] ✓ Merged by ${d.basis}: ${d.describe} → kept ${d.keeperId}, removed ${res.removed.join(', ')}`);
        summary.merged.push({ keep: d.keeperId, removed: res.removed, basis: d.basis, name: res.worker.name, ip: res.worker.ip });
      } else {
        summary.skipped.push({ ids: g.members.map(w => w.id), basis: g.basis, reason: res.error });
      }
      if (d.rejected && d.rejected.length) {
        summary.skipped.push({ ids: g.members.map(w => w.id), basis: g.basis, reason: 'partly left alone: ' + d.rejected.join('; ') });
      }
    }
    // Skips are logged once per distinct reason set per group, so the log
    // doesn't repeat the same "none online" line every 10 minutes forever.
    summary.skipped.forEach(s => {
      if (!s.ids) return;
      const key = s.ids.slice().sort().join(',') + '|' + s.reason;
      if (lastSkipLogged.has(key)) return;
      lastSkipLogged.add(key);
      console.log(`[DEDUPE] – Left alone (${s.basis}): ${s.ids.join(', ')} — ${s.reason}`);
    });
    if (summary.merged.length) console.log(`[DEDUPE] Run complete — merged ${summary.merged.length} group(s)`);
  } catch (e) {
    console.error('[DEDUPE] Run failed:', e.message);
    summary.error = e.message;
  } finally {
    running = false;
  }
  return summary;
}
const lastSkipLogged = new Set();

let timer = null;
function start() {
  if (timer) return;
  setTimeout(() => { runOnce().catch(e => console.error('[DEDUPE]', e.message)); }, FIRST_RUN_DELAY_MS);
  timer = setInterval(() => { runOnce().catch(e => console.error('[DEDUPE]', e.message)); }, RUN_EVERY_MS);
  console.log(`[DEDUPE] Automatic duplicate merging started (every ${RUN_EVERY_MS / 60000} min)`);
}

module.exports = { start, runOnce, buildGroups, evaluateGroup };
