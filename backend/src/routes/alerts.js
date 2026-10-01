// ============================================================
// ALERT SETTINGS ROUTE  /api/alerts
// ------------------------------------------------------------
// The site alarm (phone call + Telegram) fires when at least N machines
// are offline at one site. N is set here from the Settings page and
// stored on the server, so it's the same on every device and survives
// redeploys. See services/alerts.js for how it's used.
// ============================================================
const express = require('express');
const router  = express.Router();
const { authMiddleware, requireRole } = require('../middleware/auth');
const alerts  = require('../services/alerts');

function staffOnly(req, res, next) {
  if ((req.user && req.user.role) === 'customer') return res.status(403).json({ ok: false, error: 'Forbidden' });
  next();
}

// GET /api/alerts/settings → { ok, alarm_at, rearm_at, default_alarm_at }
router.get('/settings', authMiddleware, staffOnly, async (req, res) => {
  await alerts.loadAlarmSetting();
  res.json({ ok: true, ...alerts.getAlarmSettings() });
});

// POST /api/alerts/settings  { alarm_at: 15, delay_min: 10, repeat_min: 60 }
router.post('/settings', authMiddleware, requireRole('admin', 'manager'), async (req, res) => {
  const who = (req.user && (req.user.name || req.user.id)) || 'unknown';
  const b = req.body || {};
  await alerts.loadAlarmSetting();   // fields left out keep their saved value
  const r = await alerts.setAlarmAt({ alarm_at: b.alarm_at, delay_min: b.delay_min, repeat_min: b.repeat_min }, who);
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
});

// ── Auto-restart (machines at 0 hashrate) ──────────────────────────
const autorestart = require('../services/autorestart');

// GET /api/alerts/auto-restart → { ok, enabled, minutes, max_per_day, defaults, log[], machines[] }
router.get('/auto-restart', authMiddleware, staffOnly, async (req, res) => {
  await Promise.all([autorestart.loadSettings(), autorestart.loadOverrides()]);
  res.json({ ok: true, ...autorestart.getSettings(), log: autorestart.getLog(), machines: autorestart.listOverrides() });
});

// One machine's setting, as shown on its page.
// GET /api/alerts/auto-restart/machine/:id → { ok, mode, minutes, max_per_day, default{}, active, restarts_today, zero_minutes }
router.get('/auto-restart/machine/:id', authMiddleware, staffOnly, async (req, res) => {
  const r = await autorestart.getMachine(req.params.id);
  res.status(r.ok ? 200 : 404).json(r);
});

// Set one or many machines (machine page, or bulk from the Workers list).
// POST /api/alerts/auto-restart/machines  { worker_ids:[…], mode:'default'|'off'|'on', minutes, max_per_day }
router.post('/auto-restart/machines', authMiddleware, requireRole('admin', 'manager'), async (req, res) => {
  const who = (req.user && (req.user.name || req.user.id)) || 'unknown';
  const b = req.body || {};
  const r = await autorestart.setMachines(b.worker_ids || b.worker_id, b, who);
  if (!r.ok) return res.status(400).json(r);
  res.json({ ...r, machines: autorestart.listOverrides() });
});

// POST /api/alerts/auto-restart  { enabled, minutes, max_per_day }
router.post('/auto-restart', authMiddleware, requireRole('admin', 'manager'), async (req, res) => {
  const who = (req.user && (req.user.name || req.user.id)) || 'unknown';
  const r = await autorestart.saveSettings(req.body || {}, who);
  if (!r.ok) return res.status(400).json(r);
  res.json({ ...r, log: autorestart.getLog(), machines: autorestart.listOverrides() });
});

// ── Log checks (known error patterns → messages; no AI) ────────────
const logCheck = require('../services/logDiagnosis');

// GET /api/alerts/log-rules → { ok, builtin:[{id,level,message,pattern,enabled}], custom:[…] }
router.get('/log-rules', authMiddleware, staffOnly, async (req, res) => {
  res.json({ ok: true, ...logCheck.listRules(await logCheck.loadRules(true)) });
});

// POST /api/alerts/log-rules  { disabled:[builtin ids], custom:[{pattern, message, level, enabled}] }
router.post('/log-rules', authMiddleware, requireRole('admin', 'manager'), async (req, res) => {
  const who = (req.user && (req.user.name || req.user.id)) || 'unknown';
  const r = await logCheck.saveRules(req.body || {}, who);
  if (!r.ok) return res.status(400).json(r);
  console.log(`[LOG-CHECK] Rules changed by ${who}: ${r.rules.disabled.length} built-in off, ${r.rules.custom.length} own rule(s)`);
  res.json({ ok: true, ...logCheck.listRules(r.rules) });
});

// Try the rules on a pasted log, or on a machine's log fetched right now
// (nothing is posted to Telegram).
// POST /api/alerts/log-rules/test  { log } | { worker_id }
router.post('/log-rules/test', authMiddleware, staffOnly, async (req, res) => {
  const b = req.body || {};
  let text = typeof b.log === 'string' ? b.log : null, snapshot = null, machine = null;
  if (text === null && b.worker_id) {
    const db = require('../services/db');
    const agentMgr = require('../services/agentManager');
    const w = (await db.loadWorkers()).find(x => x && String(x.id) === String(b.worker_id));
    if (!w) return res.status(404).json({ ok: false, error: 'Machine not found' });
    if (!agentMgr.getAgent(w.farm_id)) return res.status(409).json({ ok: false, error: 'That farm\'s agent is offline' });
    let r;
    try { r = await agentMgr.sendActionRequest(w.farm_id, w.ip, 'downloadlogs', { brand: w.brand, model: w.model, with_snapshot: true }); }
    catch (e) { r = { ok: false, error: e.message }; }
    if (!r || !r.ok || !r.logs) return res.status(502).json({ ok: false, error: (r && r.error) || 'The miner sent no log' });
    text = String(r.logs); snapshot = r.snapshot || null;
    machine = { name: w.name, ip: w.ip, model: w.model, farm: w.farm };
  }
  if (text === null) return res.status(400).json({ ok: false, error: 'Paste a log or choose a machine' });
  const d = await logCheck.diagnose(text, snapshot);
  res.json({ ok: true, machine, findings: d.findings, lines: d.checked, snapshot,
             caption: logCheck.captionList(d.findings), log_tail: machine ? text.slice(-200000) : undefined });
});

// ── Telegram alert rules (what goes to the group) ──────────────────
const tgRules = require('../services/alertRules');

// GET /api/alerts/telegram-rules → { ok, rules, defaults, telegram, alarm_at }
router.get('/telegram-rules', authMiddleware, staffOnly, async (req, res) => {
  const rules = await tgRules.loadRules(true);
  await alerts.loadAlarmSetting();
  res.json({ ok: true, rules, defaults: tgRules.DEFAULTS, telegram: tgRules.telegramConfigured(), alarm_at: alerts.getAlarmSettings().alarm_at });
});

// POST /api/alerts/telegram-rules  { overheat:{on,temp,min}, hashdrop:{on,pct}, recovery:{on}, summary:{on,time}, autorestart_log:{on}, autorestart_paused:{on} }
router.post('/telegram-rules', authMiddleware, requireRole('admin', 'manager'), async (req, res) => {
  const who = (req.user && (req.user.name || req.user.id)) || 'unknown';
  const r = await tgRules.saveRules(req.body || {}, who);
  if (!r.ok) return res.status(400).json(r);
  res.json({ ok: true, rules: r.rules, defaults: tgRules.DEFAULTS, telegram: tgRules.telegramConfigured(), alarm_at: alerts.getAlarmSettings().alarm_at });
});

// POST /api/alerts/telegram-rules/test → posts one test message to the group
router.post('/telegram-rules/test', authMiddleware, requireRole('admin', 'manager'), async (req, res) => {
  const who = (req.user && (req.user.name || req.user.id)) || 'unknown';
  const r = await tgRules.sendTest(who);
  res.status(r.ok ? 200 : 400).json(r);
});

module.exports = router;
