// ============================================================
// ALERT SERVICE
// Sends notifications via Slack, Telegram, Discord webhooks
// ============================================================
const axios = require('axios');
const store = require('./store');
const db    = require('./db');
const agentMgr = require('./agentManager');
const https = require('https');

const WEBHOOK = process.env.ALERT_WEBHOOK_URL;
const TELEGRAM_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT   = process.env.TELEGRAM_CHAT_ID;

// Telegram can't colour text, so the colour is a dot: red = offline /
// critical, orange = warning, green = online / back to normal.
const LEVEL_EMOJI = { critical: '🔴', warn: '🟠', ok: '🟢', info: '🔵' };
const esc = v => String(v == null ? '' : v).replace(/([_*`\[])/g, '\\$1');   // for text placed inside a Markdown message

// Send a message that is ALREADY Markdown (bold site names, points). If
// Telegram rejects the formatting, the same text goes out plain rather
// than the alert being lost.
async function sendTelegramMarkdown(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return false;
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const body = String(text).slice(0, 4000);
  try { await axios.post(url, { chat_id: TELEGRAM_CHAT, text: body, parse_mode: 'Markdown' }, { timeout: 8000 }); return true; }
  catch (e) {
    const why = (e.response && e.response.data && e.response.data.description) || e.message;
    console.error('[ALERT] Telegram (formatted) failed:', why, '— sending plain');
    try { await axios.post(url, { chat_id: TELEGRAM_CHAT, text: body.replace(/\\([_*`\[])/g, '$1').replace(/\*/g, '') }, { timeout: 8000 }); return true; }
    catch (e2) { console.error('[ALERT] Telegram failed:', e2.message); return false; }
  }
}

/**
 * Send a Slack-compatible webhook alert
 */
async function sendSlackAlert(message, level = 'warn') {
  if (!WEBHOOK) return;
  try {
    await axios.post(WEBHOOK, {
      text: `${LEVEL_EMOJI[level] || '⚠️'} *Ekalavya Alert*\n${message}`,
      username: 'MMX Bot',
      icon_emoji: ':helmet_with_white_cross:',
    }, { timeout: 5000 });
  } catch (e) {
    console.error('[ALERT] Webhook failed:', e.message);
  }
}

/**
 * Send Telegram alert
 */
// title: the bold first line (default "Ekalavya Alert")
async function sendTelegramAlert(message, level = 'warn', title) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT,
      // The message body is escaped: machine names like "T21_015" contain
      // Markdown characters, and an unbalanced "_" makes Telegram reject
      // the whole message — an alert that silently never arrives.
      text: `${LEVEL_EMOJI[level] ? LEVEL_EMOJI[level] + ' ' : ''}*${String(title || 'Ekalavya Alert').replace(/([_*`\[])/g, '\\$1')}*\n${String(message).replace(/([_*`\[])/g, '\\$1')}`,
      parse_mode: 'Markdown',
    }, { timeout: 5000 });
  } catch (e) {
    console.error('[ALERT] Telegram failed:', e.message);
  }
}

// Send a text file to the Telegram group (sendDocument), with a caption.
// Built as a plain multipart upload so no extra package is needed.
// Caption: bold title line + message, escaped like sendTelegramAlert.
async function sendTelegramDocument(caption, title, filename, content) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return { ok: false, error: 'Telegram not configured' };
  const esc = v => String(v).replace(/([_*`\[])/g, '\\$1');
  let cap = (title ? '*' + esc(title) + '*\n' : '') + esc(caption);
  if (cap.length > 1024) cap = cap.slice(0, 1020).replace(/\\$/, '') + '…';   // Telegram's caption limit
  const safeName = String(filename || 'log.txt').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);
  const boundary = '----ekalavya' + Date.now().toString(16) + Math.random().toString(16).slice(2);
  const field = (name, value) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8');
  const body = Buffer.concat([
    field('chat_id', TELEGRAM_CHAT),
    field('caption', cap),
    field('parse_mode', 'Markdown'),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${safeName}"\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n`, 'utf8'),
    Buffer.isBuffer(content) ? content : Buffer.from(String(content == null ? '' : content), 'utf8'),
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ]);
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendDocument`, body, {
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
      timeout: 30000, maxBodyLength: Infinity, maxContentLength: Infinity,
    });
    return { ok: true };
  } catch (e) {
    const why = (e.response && e.response.data && e.response.data.description) || e.message;
    console.error('[ALERT] Telegram file failed:', why);
    return { ok: false, error: why };
  }
}

/**
 * Raise an alert — stores it, broadcasts via WS, and sends webhook
 */
async function raiseAlert(message, level = 'warn', metadata = {}) {
  const alert = { message, level, metadata, time: new Date().toISOString() };
  store.addAlert(alert);

  // Fire and forget webhooks
  sendSlackAlert(message, level).catch(() => {});
  // The Telegram group gets only farm-level news (site alarm, last-restart
  // log, auto-restart paused). Single-machine alerts (temperature, hashrate,
  // one machine offline) stay in the app — pass { group: true } to post one.
  if (metadata && metadata.group === true) sendTelegramAlert(message, level).catch(() => {});

  console.log(`[ALERT][${level.toUpperCase()}] ${message}`);
  return alert;
}

/**
 * Evaluate thresholds for a worker and raise alerts if needed
 */
async function checkWorkerThresholds(worker) {
  const alerts = [];

  if (worker.temperature >= 90) {
    alerts.push(raiseAlert(
      `${worker.name} (${worker.ip}): CRITICAL temperature ${worker.temperature}°C`, 'critical', { worker_id: worker.id }
    ));
  } else if (worker.temperature >= 82) {
    alerts.push(raiseAlert(
      `${worker.name} (${worker.ip}): High temperature ${worker.temperature}°C`, 'warn', { worker_id: worker.id }
    ));
  }

  const expectedHR = worker.expected_hashrate || worker.hashrate * 1.05;
  if (worker.status === 'online' && expectedHR > 0 && worker.hashrate < expectedHR * 0.85) {
    alerts.push(raiseAlert(
      `${worker.name}: Hashrate degraded — ${worker.hashrate.toFixed(1)} vs ${expectedHR.toFixed(1)} TH/s expected`, 'warn', { worker_id: worker.id }
    ));
  }

  if (worker.status === 'offline') {
    alerts.push(raiseAlert(
      `${worker.name} (${worker.ip}) is OFFLINE`, 'critical', { worker_id: worker.id }
    ));
  }

  await Promise.allSettled(alerts);
}

// ============================================================
// SITE-LEVEL OFFLINE-COUNT VOICE ALERT
// ------------------------------------------------------------
// Separate from checkWorkerThresholds above (which is per-machine and
// fires on temp/hashrate/single-machine-offline) — this is the
// "more than 10 machines offline at one SITE, warn the admins" alert,
// with a spoken voice note, not just text. Uses the SAME
// TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID as sendTelegramAlert() above, so
// it lands in the same chat unless you point it elsewhere.
//
// Fires once per threshold-crossing, not every check cycle: db.js's
// site_alerts table remembers the offline count a site was last
// alerted at, and this only re-alerts if the count has since gotten
// WORSE — never just for staying bad, and never again until it drops
// back under the threshold and crosses it fresh.
// ============================================================
// How many machines offline at ONE site raise the alarm (phone call +
// Telegram). Set from the Settings page and stored on the server
// (db app_settings, key "site_alarm_offline"); re-read on every check, so
// a change applies within one check (~3 min) with no redeploy. 11 keeps
// the original rule ("more than 10").
const DEFAULT_ALARM_AT = 11;
// A machine only counts once it has been offline for DELAY minutes without
// a break (Settings: "for N min"). Fast agent polling flips machines
// offline for a cycle now and then; counting those phoned everyone over
// machines that were back a minute later (2026-10-01). And a site is
// called at most once per REPEAT minutes, however its count moves.
const DEFAULT_DELAY_MIN  = 10;
const DEFAULT_REPEAT_MIN = 60;
const ALARM_SETTING_KEY = 'site_alarm_offline';
let alarmAt = DEFAULT_ALARM_AT, delayMin = DEFAULT_DELAY_MIN, repeatMin = DEFAULT_REPEAT_MIN;
const rearmAt = () => Math.max(0, alarmAt - 4);   // must recover to this many offline (or fewer) before a fresh alarm
async function loadAlarmSetting() {
  try {
    const v = await db.getSetting(ALARM_SETTING_KEY);
    const n = parseInt(v && v.alarm_at, 10);
    if (n >= 1 && n <= 1000) alarmAt = n;
    const d = parseInt(v && v.delay_min, 10);
    if (d >= 1 && d <= 240) delayMin = d;
    const r = parseInt(v && v.repeat_min, 10);
    if (r >= 5 && r <= 1440) repeatMin = r;
  } catch (e) { /* keep the current value */ }
}
function getAlarmSettings() {
  return { alarm_at: alarmAt, rearm_at: rearmAt(), delay_min: delayMin, repeat_min: repeatMin,
           default_alarm_at: DEFAULT_ALARM_AT, default_delay_min: DEFAULT_DELAY_MIN, default_repeat_min: DEFAULT_REPEAT_MIN };
}
// setAlarmAt(11, by) as before, or setAlarmAt({ alarm_at, delay_min, repeat_min }, by)
async function setAlarmAt(v, by) {
  const o = (v && typeof v === 'object') ? v : { alarm_at: v };
  const n = parseInt(o.alarm_at, 10);
  if (!(n >= 1 && n <= 1000)) return { ok: false, error: 'Enter a whole number of machines between 1 and 1000' };
  const d = o.delay_min === undefined ? delayMin : parseInt(o.delay_min, 10);
  if (!(d >= 1 && d <= 240)) return { ok: false, error: 'Minutes offline must be between 1 and 240' };
  const r = o.repeat_min === undefined ? repeatMin : parseInt(o.repeat_min, 10);
  if (!(r >= 5 && r <= 1440)) return { ok: false, error: 'Minutes between calls must be between 5 and 1440' };
  const saved = await db.setSetting(ALARM_SETTING_KEY, { alarm_at: n, delay_min: d, repeat_min: r }, by);
  if (!saved) return { ok: false, error: 'Could not save the setting' };
  const was = `${alarmAt} for ${delayMin} min, every ${repeatMin} min`;
  alarmAt = n; delayMin = d; repeatMin = r;
  console.log(`[ALERT] Site alarm changed: ${was} → ${n} machines offline for ${d} min at one site, at most one call per site every ${r} min${by ? ' (by ' + by + ')' : ''}`);
  return { ok: true, ...getAlarmSettings() };
}
const CHECK_EVERY_MS    = 60 * 1000;       // how often to re-check every site (each minute, so "offline for N min" is accurate)

function siteAlertingConfigured() {
  return !!(TELEGRAM_TOKEN && TELEGRAM_CHAT);
}

// ── Real phone calls via Twilio ─────────────────────────────────────
// No app, no tap, no notification setting can make a phone auto-play
// audio — that's an OS-level restriction on every platform. An actual
// phone CALL is the one thing that rings and starts talking on its own
// the moment it's answered, so this is what genuinely delivers "ringing
// tone... in voice" rather than a message someone has to open.
// Needs its own Twilio account (twilio.com — has per-minute call costs
// and, on a trial account, can only call phone numbers you've verified
// in the Twilio console first):
//   TWILIO_ACCOUNT_SID    — from the Twilio console dashboard
//   TWILIO_AUTH_TOKEN     — same page, click to reveal
//   TWILIO_FROM_NUMBER    — a Twilio phone number with Voice capability
//   TWILIO_ALERT_NUMBERS  — comma-separated admin numbers to call, in
//                           E.164 format (e.g. +971501234567,+15551234567)
const TWILIO_SID  = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM_NUMBER;
const TWILIO_TO   = (process.env.TWILIO_ALERT_NUMBERS || '').split(',').map(s => s.trim()).filter(Boolean);

function phoneCallConfigured() {
  return !!(TWILIO_SID && TWILIO_AUTH && TWILIO_FROM && TWILIO_TO.length);
}

// Speaks the alert twice with a short pause between — someone answering
// a call can easily miss the first few words while picking up, so this
// gives them a second pass rather than one shot at hearing it.
//
// Uses Twilio's standard voice unless TWILIO_VOICE names another (e.g.
// Polly.Joanna): the standard one works on every account, trial included,
// while premium voices may not.
function buildAlertTwiml(spokenText) {
  const escaped = String(spokenText).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const voice = (process.env.TWILIO_VOICE || '').replace(/[^A-Za-z0-9._-]/g, '');
  const say = `<Say${voice ? ` voice="${voice}"` : ''}>${escaped}</Say>`;
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${say}<Pause length="1"/>${say}</Response>`;
}

// ── Serving the spoken message by link ──────────────────────────────
// Twilio trial accounts refuse the message sent inline with the call
// ("trial accounts have limited parameter access"). What they do accept
// is a Url: Twilio fetches the call's script from a web address when the
// person answers. So each alert's script is kept here briefly under a
// random, unguessable id and served at /api/alerts/twiml/<id> (mounted in
// server.js). Works the same on paid accounts.
//
// The address comes from PUBLIC_BASE_URL if set, else from the domain
// Railway gives the service (RAILWAY_PUBLIC_DOMAIN). With neither, calls
// fall back to the inline message, which only paid accounts accept.
const crypto = require('crypto');
const TWIML_TTL_MS = 30 * 60 * 1000;
const pendingTwiml = new Map();   // id -> { xml, expires }

function publicBaseUrl() {
  const explicit = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  const rail = (process.env.RAILWAY_PUBLIC_DOMAIN || '').trim();
  return rail ? 'https://' + rail : null;
}

function twimlUrlFor(spokenText) {
  const base = publicBaseUrl();
  if (!base) return null;
  const now = Date.now();
  for (const [k, v] of pendingTwiml) if (v.expires < now) pendingTwiml.delete(k);
  const id = crypto.randomBytes(16).toString('hex');
  pendingTwiml.set(id, { xml: buildAlertTwiml(spokenText), expires: now + TWIML_TTL_MS });
  return `${base}/api/alerts/twiml/${id}`;
}

// Twilio asks for the script (POST by default) when the call is answered.
// No login here: Twilio can't carry one, and the random id is what keeps
// it private. An unknown or expired id still gets a valid, harmless
// script, so a late pickup hears something sensible, not an error.
function twimlHandler(req, res) {
  const entry = pendingTwiml.get(String(req.params.id || ''));
  const xml = entry && entry.expires >= Date.now()
    ? entry.xml
    : buildAlertTwiml('This Ekalavya alert has expired. Please check the dashboard.');
  res.set('Content-Type', 'text/xml');
  res.send(xml);
}

// Calls every configured admin number.
async function sendPhoneCallAlert(spokenText) {
  if (!phoneCallConfigured()) return false;
  const url = twimlUrlFor(spokenText);
  const script = url ? { Url: url } : { Twiml: buildAlertTwiml(spokenText) };
  if (!url) console.log('[ALERT] No public address known (set PUBLIC_BASE_URL) — sending the message inline, which Twilio trial accounts refuse');
  const results = await Promise.allSettled(TWILIO_TO.map(number => {
    const body = new URLSearchParams({ To: number, From: TWILIO_FROM, ...script });
    return axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Calls.json`,
      body.toString(),
      {
        auth: { username: TWILIO_SID, password: TWILIO_AUTH },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000,
      }
    );
  }));
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`[ALERT] Twilio call to ${TWILIO_TO[i]} failed:`, r.reason?.response?.data?.message || r.reason.message);
    }
  });
  const okCount = results.filter(r => r.status === 'fulfilled').length;
  console.log(`[ALERT] Twilio: ${okCount}/${TWILIO_TO.length} call(s) placed`);
  return okCount > 0;
}

// ── Free phone calls via CallMeBot (Telegram voice call) ────────────
// A second, free call channel alongside Twilio: CallMeBot places a real
// Telegram voice call to each person and reads the alert out loud, so
// the phone rings like any incoming call with nothing to open or tap.
// Twilio's free trial blocks some custom call scripts and limits who
// and where it can call — this one works without any paid account.
//
// Setup, once per person: in Telegram, send /start to @CallMeBot_txtbot
// (that is what authorises it to call you). Then set on Railway:
//   CALLMEBOT_USERS — comma-separated Telegram usernames, e.g. @abhi,@ravi
//                     (a phone number with country code, +971…, also works)
//
// It is a free shared service with no delivery guarantee, so Telegram
// text + voice note and Twilio (if set) still fire as before — this adds
// a ring, it doesn't replace anything. Known limit on their side: the
// iPhone Telegram app may ring but not play the spoken message.
const CALLMEBOT_USERS = (process.env.CALLMEBOT_USERS || '')
  .split(',').map(s => s.trim()).filter(Boolean)
  .map(u => (u.startsWith('@') || u.startsWith('+')) ? u : '@' + u);

function callMeBotConfigured() { return CALLMEBOT_USERS.length > 0; }

// Their reply is a small HTML page describing what happened (queued,
// not authorised, too many calls, …). Tags are stripped so the log line
// says in plain words why a call didn't ring.
// Their page carries analytics <script> blocks ahead of the actual
// message; those are dropped whole (not just their tags), otherwise the
// script text used up the log line and cut the real answer off.
function plainText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim().slice(0, 500);
}

async function sendCallMeBotAlert(spokenText) {
  if (!callMeBotConfigured()) return false;
  const text = String(spokenText).slice(0, 250);          // their limit is 256 characters
  let okCount = 0;
  // One after another rather than all at once: it's a shared free
  // service, and a burst of simultaneous calls is what it throttles.
  for (const user of CALLMEBOT_USERS) {
    try {
      const res = await axios.get('http://api.callmebot.com/start.php', {
        // rpt: say it twice (someone picking up can miss the start);
        // cc=missed: if the call isn't answered, they also send it as text.
        params: { user, text, rpt: 2, cc: 'missed' },
        timeout: 60000,
        responseType: 'text',
        validateStatus: () => true,
      });
      // Their reply is logged word for word — it is the only place that
      // says why a call didn't ring (e.g. the person never sent /start).
      const said = plainText(res.data);
      if (res.status === 200) { okCount++; console.log(`[ALERT] CallMeBot → ${user}: ${said}`); }
      else console.error(`[ALERT] CallMeBot → ${user} refused (HTTP ${res.status}): ${said}`);
    } catch (e) {
      console.error(`[ALERT] CallMeBot call to ${user} failed:`, e.message);
    }
  }
  console.log(`[ALERT] CallMeBot: ${okCount}/${CALLMEBOT_USERS.length} call(s) placed`);
  return okCount > 0;
}

// ── Text-to-speech via Google Translate's public TTS endpoint ──────
// No API key, no account, no cost — the same audio the "listen" button
// on translate.google.com plays. Unofficial/undocumented, so it's used
// with a graceful fallback: if it ever fails, sendSiteVoiceAlert() below
// returns false and the site check falls back to sendTelegramAlert()
// (plain text, using the existing function above) automatically.
function fetchGoogleTts(text) {
  return new Promise((resolve, reject) => {
    const q = encodeURIComponent(text.slice(0, 200));
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en&q=${q}`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error('TTS HTTP ' + res.statusCode)); return; }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ── Send the generated MP3 as a Telegram audio message ─────────────
// Uses sendAudio (not sendVoice) deliberately: Telegram's sendVoice only
// accepts OGG/Opus, which would need ffmpeg to produce from the TTS
// output above. sendAudio takes plain MP3 directly — it shows as a
// tappable audio file with a title rather than the compact round
// "voice message" bubble, but it's the same spoken audio with no extra
// encoding step or dependency. Built as a raw multipart body (rather
// than the `form-data` package) so this doesn't need a new dependency
// beyond axios, which is already used above.
async function sendSiteVoiceAlert(spokenText, caption) {
  if (!siteAlertingConfigured()) return false;
  let audio;
  try { audio = await fetchGoogleTts(spokenText); }
  catch (e) { console.error('[ALERT] TTS generation failed, falling back to text:', e.message); return false; }

  const boundary = '----EkalavyaAlert' + Date.now();
  const nl = '\r\n';
  const parts = [
    Buffer.from(`--${boundary}${nl}Content-Disposition: form-data; name="chat_id"${nl}${nl}${TELEGRAM_CHAT}${nl}`),
    Buffer.from(`--${boundary}${nl}Content-Disposition: form-data; name="caption"${nl}${nl}${String(caption).slice(0, 1020)}${nl}`),
    Buffer.from(`--${boundary}${nl}Content-Disposition: form-data; name="parse_mode"${nl}${nl}Markdown${nl}`),
    Buffer.from(`--${boundary}${nl}Content-Disposition: form-data; name="title"${nl}${nl}Site Alert${nl}`),
    Buffer.from(`--${boundary}${nl}Content-Disposition: form-data; name="audio"; filename="alert.mp3"${nl}Content-Type: audio/mpeg${nl}${nl}`),
    audio,
    Buffer.from(`${nl}--${boundary}--${nl}`),
  ];
  const payload = Buffer.concat(parts);

  try {
    const res = await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendAudio`,
      payload,
      { headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, timeout: 15000 }
    );
    return res.status === 200;
  } catch (e) {
    console.error('[ALERT] Telegram voice send failed:', e.message);
    return false;
  }
}

// ── False-alarm protection ────────────────────────────────────────
// A site's internet dropping for a few seconds used to look exactly like
// 100+ machines going offline (the agent's poll after the reconnect only
// saw part of the fleet), and phoned everyone. Now a site only alarms if
//   • it's over the threshold on TWO checks in a row (~6 min), and
//   • its farm agent isn't in the middle of reconnecting — no alarm
//     within AGENT_SETTLE_MS of it (re)connecting, or while it has only
//     just dropped.
// A site whose agent has been gone for longer than AGENT_GONE_MS still
// alarms — that is the real emergency (power or internet lost on site) —
// and says so in the message.
const AGENT_SETTLE_MS = 3 * 60 * 1000;
const AGENT_GONE_MS   = 5 * 60 * 1000;
// Once a site has alarmed, it only alarms again if at least this many MORE
// machines go down — one flaky unit flipping 65 <-> 66 must not phone
// everyone every few minutes. And when things improve, the "alerted at"
// level follows the count back down, so a one-off spike can't leave the
// bar stuck so high that a later real incident never trips it.
const WORSE_BY        = 5;

// ── Count MACHINES, not database records ──────────────────────────
// When a miner's IP changes (DHCP after a reboot or power cut), the
// poller can create a second record for it; the old record then sits
// offline until the dedupe service can safely merge it (dedupe.js —
// deliberately cautious, it can take a while). Counting records made
// every such stale copy look like another offline machine: Ghummadh
// alarmed at 19–20 offline while only 3 miners were actually down.
//
// Records at the same site that share a hardware ID (MAC or serial) are
// one physical machine here: counted once, and online if ANY of its
// records is online. Records with no hardware ID are counted as they are.
// Sleeping machines were put to sleep on purpose, so — like the app's own
// offline filter — they don't count as offline.
function normHw(kind, v) {
  if (!v) return null;
  if (kind === 'mac') {
    const h = String(v).toUpperCase().replace(/[^0-9A-F]/g, '');
    if (h.length !== 12 || /^0+$/.test(h) || /^F+$/.test(h)) return null;   // factory placeholders
    return 'mac:' + h;
  }
  const s = String(v).trim();
  if (s.length < 4 || /^(—|-|0+|unknown|none|null|n\/a)$/i.test(s)) return null;
  return 'sn:' + s;
}

function countPhysicalMachines(workers) {
  const byFarm = {};
  const groups = {};   // farm -> Map(root -> [records])
  const parent = new Map();
  const find = k => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

  const active = workers.filter(w => w && !w.disabled);   // disabled excluded, as before
  active.forEach((w, i) => {
    const fid = w.farm_id || 'unassigned';
    const self = fid + '|rec:' + (w.id || i);
    parent.set(self, self);
    [normHw('mac', w.mac), normHw('sn', w.serial)].filter(Boolean).forEach(hw => {
      const key = fid + '|' + hw;
      if (!parent.has(key)) parent.set(key, key);
      union(self, key);
    });
  });
  active.forEach((w, i) => {
    const fid = w.farm_id || 'unassigned';
    const root = find(fid + '|rec:' + (w.id || i));
    if (!groups[fid]) groups[fid] = new Map();
    if (!groups[fid].has(root)) groups[fid].set(root, []);
    groups[fid].get(root).push(w);
  });

  // A stale copy with no MAC/serial can't be grouped above. If it sits at
  // the same site and IP as a live machine and nothing says it's a
  // different machine, it's that machine (the dedupe service merges it
  // within ~30 minutes) — not a machine that's down.
  const wid = r => { const v = r && (r.worker_id || r.worker); const s = v ? String(v).trim() : ''; return s && s !== '—' ? s : null; };
  const differs = (a, b) => {
    const ma = normHw('mac', a.mac), mb = normHw('mac', b.mac); if (ma && mb && ma !== mb) return true;
    const sa = normHw('sn', a.serial), sb = normHw('sn', b.serial); if (sa && sb && sa !== sb) return true;
    const wa = wid(a), wb = wid(b); return !!(wa && wb && wa !== wb);
  };
  const liveAt = new Map();   // "farm|ip" -> live records there
  active.forEach(w => {
    if (!(w.status === 'online' || w.status === 'warn') || !w.ip) return;
    const k = (w.farm_id || 'unassigned') + '|' + w.ip;
    if (!liveAt.has(k)) liveAt.set(k, []);
    liveAt.get(k).push(w);
  });
  const copyOfLive = recs => recs.every(r => {
    const live = liveAt.get((r.farm_id || 'unassigned') + '|' + r.ip) || [];
    return live.some(l => l !== r && !differs(r, l));
  });

  for (const [fid, m] of Object.entries(groups)) {
    const c = { offline: 0, total: 0, offlineList: [], offlineKeys: [], records: 0 };
    for (const recs of m.values()) {
      c.records += recs.length;
      if (recs.some(r => r.status === 'online' || r.status === 'warn')) { c.total++; continue; }
      if (copyOfLive(recs)) continue;   // a stale copy — not another machine at all
      c.total++;
      if (recs.some(r => r.status === 'sleeping')) continue;
      c.offline++;
      const r = recs.find(x => x.name && x.name !== x.ip) || recs[0];
      c.offlineList.push(r.name && r.name !== r.ip ? `${r.name} (${r.ip || '?'})` : (r.ip || r.id || '?'));
      // stable identity of this machine across checks (for "offline for N minutes")
      const hw = recs.map(x => normHw('mac', x.mac)).find(Boolean) || recs.map(x => normHw('sn', x.serial)).find(Boolean);
      c.offlineKeys.push(hw || ('rec:' + (recs[0].id || recs[0].ip)));
    }
    byFarm[fid] = c;
  }
  return byFarm;
}

// Short list of which machines are down, for the Telegram text — so an
// alarm can be checked at a glance instead of trusted blindly. Kept short:
// Telegram captions are capped at 1024 characters.
function offlineListText(counts, max = 12) {
  const l = counts.offlineList || [];
  if (!l.length) return '';
  const shown = l.slice(0, max).map(s => '• ' + esc(String(s).slice(0, 40)));
  return '\n\nOffline machines:\n' + shown.join('\n') + (l.length > max ? `\n… +${l.length - max} more` : '');
}
const startedAt       = Date.now();
const lastSeenAgent   = new Map();   // farm_id -> last time we saw it connected
const downSince       = new Map();   // "farm|machine" -> since when it has been offline without a break
const lastCallAt      = new Map();   // "farm|down" / "farm|gone" -> when this site last alarmed (call + Telegram)
const calmSince       = new Map();   // farm_id -> since when it has been back at/below the re-arm level

// ── The actual per-site check, run on a timer by start() below ─────
async function checkSiteOfflineCounts() {
  await loadAlarmSetting();   // picks up a change made on the Settings page
  const workers = await db.loadWorkers();
  const agents  = agentMgr.getAgents();
  const now = Date.now();
  const delayMs = delayMin * 60 * 1000, repeatMs = repeatMin * 60 * 1000;
  agents.forEach(a => lastSeenAgent.set(a.farm_id, now));

  const byFarm = countPhysicalMachines(workers);
  const farmNames = {};
  workers.forEach(w => { const fid = w.farm_id || 'unassigned'; if (w.farm && !farmNames[fid]) farmNames[fid] = w.farm; });

  // How long has each machine been offline without a break? A machine seen
  // online at any check starts again from zero.
  const offNow = new Set();
  for (const [farmId, counts] of Object.entries(byFarm)) {
    (counts.offlineKeys || []).forEach(k => { const key = farmId + '|' + k; offNow.add(key); if (!downSince.has(key)) downSince.set(key, now); });
  }
  for (const key of [...downSince.keys()]) if (!offNow.has(key)) downSince.delete(key);

  for (const [farmId, counts] of Object.entries(byFarm)) {
    const agent = agents.find(a => a.farm_id === farmId);
    const farmName = (agent && agent.farm_name) || farmNames[farmId] || farmId;
    if (farmId === 'unassigned') continue;   // not a real site
    const prev = await db.getSiteAlertState(farmId);

    // Only machines offline for the set minutes count.
    const longList = [];
    (counts.offlineKeys || []).forEach((k, i) => { if (now - (downSince.get(farmId + '|' + k) || now) >= delayMs) longList.push(counts.offlineList[i]); });
    const down = longList.length;

    if (down < alarmAt) {
      if (prev !== null) {
        // Only re-arm once the site has CLEARLY recovered (alarm number − 4
        // or fewer) and stayed there a while; a dip that comes straight back
        // just lowers the "alerted at" level.
        if (down <= rearmAt()) {
          if (!calmSince.has(farmId)) calmSince.set(farmId, now);
          if (now - calmSince.get(farmId) >= Math.min(delayMs, 10 * 60 * 1000)) {
            calmSince.delete(farmId);
            await db.clearSiteAlertState(farmId);
            console.log(`[ALERT] ${farmName}: back to normal — ${down} machine(s) offline ${delayMin}+ min`);
            // one "back to normal" message (Settings › Telegram Alerts › recovery)
            try { await require('./alertRules').siteRecovered(farmName, { offline: counts.offline, total: counts.total, alarmedAt: prev }); } catch (e) {}
          }
        } else {
          calmSince.delete(farmId);
          if (down < prev) await db.setSiteAlertState(farmId, down);
        }
      }
      continue;
    }
    calmSince.delete(farmId);

    // Is this site's agent settled enough for the numbers to mean anything?
    let agentGone = false;
    if (agent) {
      if (now - new Date(agent.connected_at).getTime() < AGENT_SETTLE_MS) {
        console.log(`[ALERT] ${farmName}: ${down} offline, but its agent only just (re)connected — waiting before alarming`);
        continue;
      }
    } else {
      const seen = lastSeenAgent.get(farmId) || startedAt;
      if (now - seen < Math.max(AGENT_GONE_MS, delayMs)) continue;   // just dropped — may be a blip
      agentGone = true;
    }

    // Already alerted: follow improvements down silently, and only
    // re-alert once it's clearly WORSE than that, not just for staying bad.
    if (prev !== null && down < prev) { await db.setSiteAlertState(farmId, down); continue; }
    if (prev !== null && down < prev + WORSE_BY) continue;

    // At most one alarm per site per REPEAT minutes, whatever the count does.
    // "Site unreachable" (power / internet lost) is its own alarm: an earlier
    // offline-count call doesn't hold it back.
    const kind = farmId + '|' + (agentGone ? 'gone' : 'down');
    const last = lastCallAt.get(kind);
    if (last && now - last < repeatMs) {
      console.log(`[ALERT] ${farmName}: ${down} offline ${delayMin}+ min — already alarmed ${Math.round((now - last) / 60000)} min ago, next alarm allowed in ${Math.ceil((repeatMs - (now - last)) / 60000)} min`);
      continue;
    }

    const text = agentGone
      ? `🔴 *Site unreachable — ${esc(farmName)}*\n🔴 Farm PC disconnected for ${Math.max(AGENT_GONE_MS, delayMs) / 60000}+ min\n🔴 Offline: *${down}* of ${counts.total} machines\nThe site may have lost power or internet.`
      : `🔴 *Site alarm — ${esc(farmName)}*\n🔴 Offline: *${down}* of ${counts.total} machines (${delayMin}+ min)\n🟢 Online: ${Math.max(0, counts.total - counts.offline)}`
        + offlineListText({ offlineList: longList });
    const spoken = agentGone
      ? `Warning. ${farmName} is not reachable. The site may have lost power or internet. Please check.`
      : `Warning. ${down} machines have been offline for ${delayMin} minutes at ${farmName}. Please check.`;

    console.log(`[ALERT] ${farmName}: ${down} offline for ${delayMin}+ min (alarm at ${alarmAt}${agentGone ? ', agent unreachable' : ''}) — sending alerts`);
    lastCallAt.set(kind, now);
    // Fire both channels together — the phone call is the one that
    // actually gets heard with no tap required, Telegram is the
    // always-on record even if a call goes unanswered.
    const [voiceOk] = await Promise.all([
      sendSiteVoiceAlert(spoken, text),
      sendPhoneCallAlert(spoken),
      sendCallMeBotAlert(spoken),
    ]);
    if (!voiceOk) await sendTelegramMarkdown(text);   // voice note failed → the same text as a normal message
    await db.setSiteAlertState(farmId, down);
  }
}

let siteAlertTimer = null;
// Places one test call on every configured call channel when the server
// starts with ALERT_TEST_CALL=1 — a way to check the phone really rings
// without waiting for a real outage. Remove the variable afterwards, or
// every restart/redeploy will ring you again.
async function sendTestCalls() {
  const spoken = 'This is a test call from Ekalavya. Site alert calls are working.';
  console.log('[ALERT] ALERT_TEST_CALL=1 — placing a test call on every configured call channel');
  if (phoneCallConfigured()) await sendPhoneCallAlert(spoken);
  if (callMeBotConfigured()) await sendCallMeBotAlert(spoken);
  if (!phoneCallConfigured() && !callMeBotConfigured()) console.log('[ALERT] Test call skipped — no call channel (Twilio or CallMeBot) is configured');
}

function start() {
  if (!siteAlertingConfigured() && !phoneCallConfigured() && !callMeBotConfigured()) {
    console.log('[ALERT] No alert channel is configured — Telegram (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID), Twilio (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_FROM_NUMBER/TWILIO_ALERT_NUMBERS) or CallMeBot (CALLMEBOT_USERS) — site offline-count alerts are disabled.');
    return;
  }
  const channels = [
    siteAlertingConfigured() && 'Telegram',
    phoneCallConfigured()    && `Twilio call (${TWILIO_TO.length} number(s))`,
    callMeBotConfigured()    && `CallMeBot call (${CALLMEBOT_USERS.join(', ')})`,
  ].filter(Boolean).join(' + ');
  loadAlarmSetting().finally(() =>
    console.log(`[ALERT] Site offline-count alerting active via ${channels} — checking every ${CHECK_EVERY_MS / 60000}m, alarm at ${alarmAt}+ machines offline for ${delayMin}+ min at one site (excluding disabled), at most one alarm per site every ${repeatMin} min.`));
  // Say plainly when a call channel is off, so a missing or misspelt
  // variable shows up in the startup log instead of as a silent no-call
  // during a real outage (which is how the Twilio mix-up went unnoticed).
  if (phoneCallConfigured()) {
    const base = publicBaseUrl();
    console.log(base
      ? `[ALERT] Twilio will fetch each call's message from ${base}/api/alerts/twiml/…`
      : '[ALERT] Twilio: no public address known — set PUBLIC_BASE_URL (e.g. https://your-backend.up.railway.app), trial accounts need it');
  }
  if (!phoneCallConfigured()) {
    const missing =['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER', 'TWILIO_ALERT_NUMBERS'].filter(k => !process.env[k]);
    console.log(`[ALERT] Twilio calls OFF${missing.length ? ' — not set: ' + missing.join(', ') : ''}`);
  }
  if (!callMeBotConfigured()) console.log('[ALERT] CallMeBot calls OFF — CALLMEBOT_USERS not set');
  if (process.env.ALERT_TEST_CALL === '1') sendTestCalls().catch(e => console.error('[ALERT] Test call error:', e.message));
  if (siteAlertingConfigured()) { try { require('./alertRules').start(); } catch (e) { console.error('[TG-RULES] not started:', e.message); } }
  checkSiteOfflineCounts().catch(e => console.error('[ALERT]', e.message));
  siteAlertTimer = setInterval(() => { checkSiteOfflineCounts().catch(e => console.error('[ALERT]', e.message)); }, CHECK_EVERY_MS);
}

module.exports = { sendTelegramMarkdown, esc, sendTelegramDocument, raiseAlert, sendSlackAlert, sendTelegramAlert, checkWorkerThresholds, start, checkSiteOfflineCounts, twimlHandler,
                   getAlarmSettings, setAlarmAt, loadAlarmSetting, countPhysicalMachines };
