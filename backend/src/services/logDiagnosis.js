// ============================================================
// MINER LOG CHECK — no AI
// ------------------------------------------------------------
// Reads a miner's log (and, from agent v1.1.45, a snapshot of its fans
// and hashboards taken at the same moment) and turns known error lines
// into short messages for the team:
//
//   • Fan 2 = 0 RPM — change fan 2
//   • Chain 1 = 55 chips detected (other chains 76) — check hashboard
//   • Power error — check PSU, power cable and input voltage
//
// Two sources:
//   1. the snapshot (fan RPMs, chips per chain as the miner reports them
//      in its stats) — numbers, not guesswork;
//   2. rules: a line of the log that matches a pattern gives a message.
//      The built-in rules below are a STARTING SET for Bitmain/Antminer
//      stock-firmware logs; they are meant to be checked against real
//      logs from this fleet. Each can be switched off in Settings › Log
//      checks, and the team can add its own (text or /regex/ → message).
//
// Stored in app_settings key `log_rules`:
//   { disabled: [builtin ids], custom: [{ id, pattern, message, level }] }
// ============================================================
const db = require('./db');

const RULES_KEY = 'log_rules';
const MAX_CUSTOM = 100;

// ── Built-in rules ───────────────────────────────────────────────
// `re` is tested per line (case-insensitive). `msg` may use $1, $2 … for
// what the pattern captured. `level`: 'error' (the likely cause) or
// 'warn'. Chip counts are handled separately (see chipsFromLog) because
// they need all chains compared together.
const BUILTIN = [
  { id: 'fan-slow',     level: 'error', re: /fan\s*#?\s*(\d+)\s*(?:speed)?\s*(?:is\s+)?(?:too\s+low|error|err|lost|fail)/i,
    msg: 'Fan $1 error (too slow / not spinning) — change fan $1' },
  { id: 'fan-lost',     level: 'error', re: /ERROR_FAN_LOST|fan\s*lost|fan\s*err\b|fan\s+error|fan\s+speed\s+(?:is\s+)?too\s+low/i,
    msg: 'Fan error (fan lost / too slow) — check and change the fan' },
  { id: 'overheat',     level: 'error', re: /ERROR_TEMP_TOO_HIGH|over\s*max\s*temp|temp(?:erature)?\s+(?:is\s+)?too\s+high|over\s*heat|overheat/i,
    msg: 'Over-temperature — check airflow, fans, heat sinks and room temperature' },
  { id: 'temp-sensor',  level: 'error', re: /temp(?:erature)?\s*sensor.{0,30}(?:fail|error|lost|invalid)|(?:read|get)\s+temp(?:erature)?.{0,20}(?:fail|error)|ERROR_TEMP_SENSOR/i,
    msg: 'Temperature sensor error on a hashboard — board needs checking' },
  { id: 'power',        level: 'error', re: /ERROR_POWER|power\s*(?:voltage\s*)?(?:err\b|error)|power\s+(?:init|initiali[sz]ation)\s+fail|get\s+power\s+type.{0,20}fail|power\s+voltage\s+can\s*not\s+meet|voltage\s+drop|(?:psu|apw)\w*\s.{0,30}(?:fail|error|fault)/i,
    msg: 'Power error — check PSU, power cable and input voltage' },
  { id: 'eeprom',       level: 'error', re: /eeprom.{0,40}(?:fail|error|invalid|not\s+(?:found|loaded)|crc)/i,
    msg: 'Hashboard EEPROM error — board data can\'t be read (board repair)' },
  { id: 'soc-init',     level: 'error', re: /ERROR_SOC_INIT|soc\s+init\s+fail/i,
    msg: 'Control board could not start the hashboards (SOC init failed) — check control board / reflash firmware' },
  { id: 'pic',          level: 'error', re: /\bpic\b.{0,40}(?:fail|error)/i,
    msg: 'Hashboard PIC (voltage controller) error — check hashboard' },
  { id: 'no-board',     level: 'error', re: /(?:no|bad)\s+(?:hash\s*)?(?:board|chain)s?\b(?!\s*id\s*=)|(?:hash\s*board|chain)\s*\[?\s*(\d+)?\s*\]?\s*(?:is\s+)?(?:not\s+(?:found|detected|exist)|missing)/i,
    msg: 'Hashboard not detected — check hashboard, its data cable and power connector' },
  { id: 'chain-off',    level: 'error', re: /(?:will\s+)?power\s+off\s+hash\s*board\s*(\d+)|disable\s+chain\s*\[?\s*(\d+)/i,
    msg: 'Hashboard $1 switched off by the miner — check hashboard $1' },
  { id: 'network',      level: 'warn',  re: /ERROR_NETWORK|network\s+(?:lost|down|unreachable)|(?:pool|stratum).{0,40}(?:connect(?:ion)?\s+fail|not\s+alive|dead|refused|timeout)/i,
    msg: 'Pool / network problem — check internet, pool address and worker name' },
  { id: 'stop-mining',  level: 'error', re: /stop_mining:?\s*(.{3,80})/i,
    msg: 'Miner stopped: $1' },
  { id: 'error-code',   level: 'warn',  re: /\b(ERROR_[A-Z0-9_]{3,40})\b/,
    msg: 'Miner error code $1' },
];

// "Chain[0]: find 76 asic", "Chain 2 only find 72 asic", "chain 1 asic num = 55"
const CHIP_RE = /chain\s*\[?\s*(\d+)\s*\]?\s*[:,]?\s*(?:only\s+)?(?:find|found|detect(?:ed)?)\s+(\d+)\s*(?:asic|chip)|chain\s*\[?\s*(\d+)\s*\]?.{0,20}?(?:asic|chip)\s*(?:num(?:ber)?|count)\s*[:=]?\s*(\d+)/i;

let rulesCache = null, rulesAt = 0;
async function loadRules(force) {
  if (!force && rulesCache && Date.now() - rulesAt < 60 * 1000) return rulesCache;
  let v = null;
  try { v = await db.getSetting(RULES_KEY); } catch (e) {}
  rulesCache = sanitizeRules(v);
  rulesAt = Date.now();
  return rulesCache;
}
function sanitizeRules(v) {
  const out = { disabled: [], custom: [] };
  if (!v || typeof v !== 'object') return out;
  if (Array.isArray(v.disabled)) out.disabled = v.disabled.filter(id => BUILTIN.some(b => b.id === id));
  if (Array.isArray(v.custom)) out.custom = v.custom.filter(c => c && typeof c.pattern === 'string' && c.pattern.trim() && typeof c.message === 'string' && c.message.trim())
    .slice(0, MAX_CUSTOM)
    .map(c => ({ id: String(c.id || ('c' + Math.random().toString(36).slice(2, 8))), pattern: c.pattern.trim().slice(0, 300),
                 message: c.message.trim().slice(0, 200), level: c.level === 'warn' ? 'warn' : 'error', enabled: c.enabled !== false }));
  return out;
}
// "text" → contains (any case); "/regex/" → regular expression
function compilePattern(p) {
  const s = String(p || '').trim();
  const m = s.match(/^\/(.+)\/([a-z]*)$/i);
  if (m) {
    try { return { re: new RegExp(m[1], 'i') }; }
    catch (e) { return { error: 'Not a valid pattern: ' + e.message }; }
  }
  if (!s) return { error: 'Pattern is empty' };
  return { re: new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') };
}
async function saveRules(v, by) {
  const clean = sanitizeRules(v);
  for (const c of clean.custom) { const r = compilePattern(c.pattern); if (r.error) return { ok: false, error: `"${c.pattern}": ${r.error}` }; }
  await db.setSetting(RULES_KEY, clean, by);
  rulesCache = clean; rulesAt = Date.now();
  return { ok: true, rules: clean };
}
function listRules(rules) {
  return {
    builtin: BUILTIN.map(b => ({ id: b.id, level: b.level, message: b.msg, pattern: '/' + b.re.source + '/', enabled: !rules.disabled.includes(b.id) })),
    custom: rules.custom,
  };
}

function fill(msg, m) {
  return String(msg).replace(/\$(\d)/g, (_, n) => (m && m[+n] !== undefined && m[+n] !== null) ? m[+n] : '').replace(/\s{2,}/g, ' ').replace(/\s+—/g, ' —').trim();
}
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };

// ── Snapshot (agent v1.1.45+): { fans:[rpm|null], chains:[{index, asic, rate}], fan_source, chain_source } ──
function snapshotFindings(snap) {
  const out = [];
  if (!snap || typeof snap !== 'object') return out;
  const fans = (Array.isArray(snap.fans) ? snap.fans : []).map(num);
  const real = fans.filter(v => v !== null && v > 0 && v < 20000);
  if (real.length) {                                     // all 0 = no fans (hydro / immersion) → nothing to say
    const top = Math.max(...real);
    fans.forEach((v, i) => {
      if (v === null || v >= 20000) return;              // empty slot / bogus reading
      if (v === 0 && snap.fans_all_slots === false) return;   // slot may simply be unused
      if (v === 0) out.push({ level: 'error', key: 'fan' + (i + 1), text: `Fan ${i + 1} = 0 RPM — change fan ${i + 1}` });
      else if (top >= 2000 && v < top * 0.4) out.push({ level: 'error', key: 'fan' + (i + 1), text: `Fan ${i + 1} = ${v} RPM (others up to ${top}) — fan ${i + 1} failing, change it` });
    });
  }
  const chains = (Array.isArray(snap.chains) ? snap.chains : []).filter(c => c && num(c.asic) !== null);
  if (chains.length) {
    const most = Math.max(...chains.map(c => num(c.asic)));
    chains.forEach(c => {
      const n = num(c.asic), label = `Chain ${c.index}`;
      if (n === 0 && most > 0) out.push({ level: 'error', key: 'chips' + c.index, text: `${label} = 0 chips detected (other chains ${most}) — hashboard not working, check board, data cable and power` });
      else if (n > 0 && n < most) out.push({ level: 'error', key: 'chips' + c.index, text: `${label} = ${n} chips detected (other chains ${most}) — check hashboard` });
    });
    if (most === 0 && chains.length) out.push({ level: 'error', key: 'chips-all', text: 'No chips detected on any hashboard — check PSU / control board / hashboard cables' });
    chains.forEach(c => {
      if (c.eeprom === false) out.push({ level: 'error', key: 'eeprom' + c.index, text: `Chain ${c.index}: EEPROM not loaded — board data can't be read (board repair)` });
    });
  }
  return out;
}

// Chip counts from the log: last count per chain, compared with the others.
function chipsFromLog(lines) {
  const per = new Map();       // chain → { n, line }
  lines.forEach(line => {
    const m = line.match(CHIP_RE);
    if (!m) return;
    const ch = m[1] !== undefined ? m[1] : m[3], n = Number(m[2] !== undefined ? m[2] : m[4]);
    if (ch === undefined || !Number.isFinite(n)) return;
    per.set(ch, { n, line: line.trim() });
  });
  if (!per.size) return [];
  const most = Math.max(...[...per.values()].map(v => v.n));
  const out = [];
  [...per.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).forEach(([ch, v]) => {
    if (v.n === 0) out.push({ level: 'error', key: 'chips' + ch, evidence: v.line, text: `Chain ${ch} = 0 chips detected${most > 0 ? ` (other chains ${most})` : ''} — hashboard not working, check board, data cable and power` });
    else if (v.n < most) out.push({ level: 'error', key: 'chips' + ch, evidence: v.line, text: `Chain ${ch} = ${v.n} chips detected (other chains ${most}) — check hashboard` });
  });
  return out;
}

// → { findings: [{ level, text, evidence?, source, rule? }], checked: n lines }
async function diagnose(logText, snapshot, rulesOverride) {
  const rules = rulesOverride || await loadRules();
  const text = String(logText || '');
  const lines = text.split(/\r?\n/).slice(-20000);
  const findings = [];
  const seen = new Set();
  const add = f => {
    const k = (f.key || f.text).toLowerCase();
    if (seen.has(k)) { const e = findings.find(x => (x.key || x.text).toLowerCase() === k); if (e) e.count = (e.count || 1) + 1; return; }
    seen.add(k); findings.push(f);
  };

  // 1. snapshot numbers first (most exact); chip counts from the log only if the snapshot has none
  const snap = snapshotFindings(snapshot);
  snap.forEach(f => add({ ...f, source: 'miner stats' }));
  const snapHasChips = !!(snapshot && Array.isArray(snapshot.chains) && snapshot.chains.some(c => c && num(c.asic) !== null));
  if (!snapHasChips) chipsFromLog(lines).forEach(f => add({ ...f, source: 'log' }));

  // 2. rules, line by line
  const active = [
    ...rules.custom.filter(c => c.enabled !== false).map(c => ({ id: c.id, level: c.level, re: compilePattern(c.pattern).re, msg: c.message, custom: true })).filter(r => r.re),
    ...BUILTIN.filter(b => !rules.disabled.includes(b.id)),
  ];
  const fanNumbered = new Set(snap.filter(f => /^fan\d+$/.test(f.key)).map(f => f.key));
  for (const line of lines) {
    if (!line || line.length > 2000) continue;
    for (const r of active) {
      const m = line.match(r.re);
      if (!m) continue;
      if (r.id === 'error-code' && active.some(o => o !== r && o.id !== 'error-code' && o.id !== 'stop-mining' && o.re.test(line))) continue;   // a named rule already covers it
      let key = r.custom ? 'custom:' + r.id + ':' + fill(r.msg, m) : r.id + ':' + fill(r.msg, m);
      if (r.id === 'fan-slow') { if (fanNumbered.has('fan' + m[1])) continue; key = 'fan' + m[1]; }
      if (r.id === 'fan-lost' && (fanNumbered.size || findings.some(f => /^fan\d+$/.test(f.key || '')))) continue;   // a numbered fan message says more
      add({ level: r.level, key, text: fill(r.msg, m), evidence: line.trim().slice(0, 300), source: r.custom ? 'your rule' : 'log', rule: r.id });
    }
  }
  // errors first, then warnings; keep log order inside each
  findings.sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));
  return { findings, checked: lines.length };
}

// Short list for the Telegram caption (fits in `max` characters).
function captionList(findings, max = 700) {
  if (!findings || !findings.length) return 'No known error found in the log — please check the file.';
  const lines = [];
  let used = 0;
  for (let i = 0; i < findings.length; i++) {
    const f = findings[i];
    const l = '• ' + f.text + (f.count > 1 ? ` (×${f.count})` : '');
    const rest = findings.length - i - 1;
    if (used + l.length + 1 + (rest ? 22 : 0) > max) { lines.push(`+${findings.length - i} more in the file`); break; }
    lines.push(l); used += l.length + 1;
  }
  return 'Possible issues:\n' + lines.join('\n');
}

// Block for the top of the .txt file: each finding + the log line behind it.
function fileBlock(findings, snapshot) {
  const out = ['Automatic check (no AI — known error patterns; verify before repair):'];
  if (!findings.length) out.push('  No known error found.');
  findings.forEach(f => {
    out.push('  • ' + f.text + (f.count > 1 ? ` (×${f.count})` : '') + (f.source ? `   [${f.source}]` : ''));
    if (f.evidence) out.push('      log: ' + f.evidence);
  });
  if (snapshot && ((snapshot.fans && snapshot.fans.length) || (snapshot.chains && snapshot.chains.length))) {
    out.push('');
    if (snapshot.fans && snapshot.fans.length) out.push('Fans (RPM): ' + snapshot.fans.map((v, i) => `${i + 1}=${v === null ? '—' : v}`).join('  '));
    if (snapshot.chains && snapshot.chains.length) out.push('Chips per chain: ' + snapshot.chains.map(c => `chain ${c.index}=${c.asic === null || c.asic === undefined ? '—' : c.asic}`).join('  '));
  }
  return out.join('\n');
}

module.exports = { diagnose, captionList, fileBlock, loadRules, saveRules, listRules, compilePattern, sanitizeRules, BUILTIN, RULES_KEY };
