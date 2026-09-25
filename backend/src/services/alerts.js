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

const LEVEL_EMOJI = { critical: '🔴', warn: '🟡', info: '🔵' };

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
async function sendTelegramAlert(message, level = 'warn') {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT,
      text: `${LEVEL_EMOJI[level]} *Ekalavya Alert*\n${message}`,
      parse_mode: 'Markdown',
    }, { timeout: 5000 });
  } catch (e) {
    console.error('[ALERT] Telegram failed:', e.message);
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
  sendTelegramAlert(message, level).catch(() => {});

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
const OFFLINE_THRESHOLD = 10;              // "more than 10" → alerts at 11+
const CHECK_EVERY_MS    = 3 * 60 * 1000;   // how often to re-check every site

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
function buildAlertTwiml(spokenText) {
  const escaped = spokenText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?><Response>`
    + `<Say voice="Polly.Joanna">${escaped}</Say>`
    + `<Pause length="1"/>`
    + `<Say voice="Polly.Joanna">${escaped}</Say>`
    + `</Response>`;
}

// Calls every configured admin number. Twilio synthesizes the speech
// itself from the inline Twiml param — no audio file, no hosting a
// webhook to serve TwiML from, unlike the Telegram voice note above.
async function sendPhoneCallAlert(spokenText) {
  if (!phoneCallConfigured()) return false;
  const twiml = buildAlertTwiml(spokenText);
  const results = await Promise.allSettled(TWILIO_TO.map(number => {
    const body = new URLSearchParams({ To: number, From: TWILIO_FROM, Twiml: twiml });
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
    Buffer.from(`--${boundary}${nl}Content-Disposition: form-data; name="caption"${nl}${nl}${caption}${nl}`),
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

// ── The actual per-site check, run on a timer by start() below ─────
async function checkSiteOfflineCounts() {
  const workers = await db.loadWorkers();
  const agents  = agentMgr.getAgents();

  const byFarm = {};
  workers.forEach(w => {
    if (w.disabled) return;   // excluded, exactly as asked
    const fid = w.farm_id || 'unassigned';
    if (!byFarm[fid]) byFarm[fid] = { offline: 0, total: 0 };
    byFarm[fid].total++;
    if (w.status !== 'online' && w.status !== 'warn') byFarm[fid].offline++;
  });

  for (const [farmId, counts] of Object.entries(byFarm)) {
    const agent = agents.find(a => a.farm_id === farmId);
    const farmName = (agent && agent.farm_name) || farmId;
    const prev = await db.getSiteAlertState(farmId);

    if (counts.offline <= OFFLINE_THRESHOLD) {
      if (prev !== null) await db.clearSiteAlertState(farmId);   // back under threshold — next crossing alerts fresh
      continue;
    }
    // Already alerted at this count or higher — only re-alert if it's
    // gotten WORSE since then, not just for staying bad.
    if (prev !== null && counts.offline <= prev) continue;

    const text = `${counts.offline} of ${counts.total} machines are offline at ${farmName} (excluding disabled). Threshold: ${OFFLINE_THRESHOLD}.`;
    const spoken = `Warning. ${counts.offline} machines are offline at ${farmName}. Please be warned.`;

    console.log(`[ALERT] ${farmName}: ${counts.offline} offline (threshold ${OFFLINE_THRESHOLD}) — sending alerts`);
    // Fire both channels together — the phone call is the one that
    // actually gets heard with no tap required, Telegram is the
    // always-on record even if a call goes unanswered.
    const [voiceOk] = await Promise.all([
      sendSiteVoiceAlert(spoken, text),
      sendPhoneCallAlert(spoken),
    ]);
    if (!voiceOk) await sendTelegramAlert(text, 'critical');   // fall back to the existing text-alert function above
    await db.setSiteAlertState(farmId, counts.offline);
  }
}

let siteAlertTimer = null;
function start() {
  if (!siteAlertingConfigured() && !phoneCallConfigured()) {
    console.log('[ALERT] Neither Telegram (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID) nor Twilio (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_FROM_NUMBER/TWILIO_ALERT_NUMBERS) is configured — site offline-count alerts are disabled.');
    return;
  }
  const channels = [siteAlertingConfigured() && 'Telegram', phoneCallConfigured() && 'phone call'].filter(Boolean).join(' + ');
  console.log(`[ALERT] Site offline-count alerting active via ${channels} — checking every ${CHECK_EVERY_MS / 60000}m, threshold ${OFFLINE_THRESHOLD} offline (excluding disabled).`);
  checkSiteOfflineCounts().catch(e => console.error('[ALERT]', e.message));
  siteAlertTimer = setInterval(() => { checkSiteOfflineCounts().catch(e => console.error('[ALERT]', e.message)); }, CHECK_EVERY_MS);
}

module.exports = { raiseAlert, sendSlackAlert, sendTelegramAlert, checkWorkerThresholds, start, checkSiteOfflineCounts };
