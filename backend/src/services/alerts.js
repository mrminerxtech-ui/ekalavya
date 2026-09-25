// ── Offline-count Telegram alerting ────────────────────────────────
// The user asked for: "if more than 10 machines are offline (excluding
// disabled) at a single site, warn the admins — in voice." This checks
// every farm on a timer and, when a site crosses that threshold, sends
// a Telegram message with BOTH a spoken voice note (text-to-speech,
// generated here with no external account needed — see sendTelegramVoice
// below) and a plain text alert as a fallback if the voice note fails
// to generate or send for any reason.
//
// Fires once per crossing, not every check cycle: db.js's site_alerts
// table remembers the offline count this site was last alerted at, and
// this only alerts again if the count has since gotten WORSE (or the
// site dropped back under the threshold and crossed it again fresh).
// That matches what was asked for — "once, then only if it gets worse"
// — rather than nagging every few minutes for the same unresolved issue.
//
// Setup (see SETUP.md or the message that accompanies this file):
//   1. Create a bot with @BotFather on Telegram, get its token.
//   2. Add the bot to the admin group (or DM it directly), send it any
//      message, then hit https://api.telegram.org/bot<TOKEN>/getUpdates
//      to find the chat_id to alert.
//   3. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in Railway's env vars.
//   4. `npm install node-gtts` in backend/ (free, no API key — it uses
//      Google Translate's public TTS endpoint, same as the "listen"
//      button on translate.google.com).
//
// If TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID aren't set, this logs one line
// on startup and does nothing else — it's fully optional and never
// blocks or slows down anything else the server does.
const https = require('https');
const db    = require('./db');
const agentMgr = require('./agentManager');

const OFFLINE_THRESHOLD = 10;              // "more than 10" → alerts at 11+
const CHECK_EVERY_MS    = 3 * 60 * 1000;   // how often to re-check every site

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

function telegramConfigured() {
  return !!(BOT_TOKEN && CHAT_ID);
}

// ── Plain text alert — the guaranteed-to-work fallback ─────────────
function sendTelegramText(text) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode !== 200) console.error('[ALERTS] Telegram sendMessage failed:', res.statusCode, d.slice(0, 300));
        resolve(res.statusCode === 200);
      });
    });
    req.on('error', e => { console.error('[ALERTS] Telegram text send error:', e.message); resolve(false); });
    req.write(body); req.end();
  });
}

// ── Text-to-speech via Google Translate's public TTS endpoint ──────
// No API key, no account, no cost — the same audio the "listen" button
// on translate.google.com plays. It's meant for short phrases (hence
// the 200-char cap here, well over what an alert sentence needs) and
// is unofficial/undocumented, so it's used with a graceful fallback:
// if it ever stops working, sendTelegramVoice() below returns false and
// checkOfflineCounts() falls back to the plain text alert automatically.
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
// "voice message" bubble, but it's the same spoken audio and needs no
// extra encoding step or dependency.
function sendTelegramVoice(spokenText, caption) {
  return new Promise(async (resolve) => {
    let audio;
    try { audio = await fetchGoogleTts(spokenText); }
    catch (e) { console.error('[ALERTS] TTS generation failed, falling back to text:', e.message); resolve(false); return; }

    const boundary = '----EkalavyaAlert' + Date.now();
    const nl = '\r\n';
    const parts = [
      Buffer.from(`--${boundary}${nl}Content-Disposition: form-data; name="chat_id"${nl}${nl}${CHAT_ID}${nl}`),
      Buffer.from(`--${boundary}${nl}Content-Disposition: form-data; name="caption"${nl}${nl}${caption}${nl}`),
      Buffer.from(`--${boundary}${nl}Content-Disposition: form-data; name="parse_mode"${nl}${nl}HTML${nl}`),
      Buffer.from(`--${boundary}${nl}Content-Disposition: form-data; name="title"${nl}${nl}Site Alert${nl}`),
      Buffer.from(`--${boundary}${nl}Content-Disposition: form-data; name="audio"; filename="alert.mp3"${nl}Content-Type: audio/mpeg${nl}${nl}`),
      audio,
      Buffer.from(`${nl}--${boundary}--${nl}`),
    ];
    const payload = Buffer.concat(parts);

    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendAudio`,
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': payload.length },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode !== 200) console.error('[ALERTS] Telegram sendAudio failed:', res.statusCode, d.slice(0, 300));
        resolve(res.statusCode === 200);
      });
    });
    req.on('error', e => { console.error('[ALERTS] Telegram voice send error:', e.message); resolve(false); });
    req.write(payload); req.end();
  });
}

// ── The actual check, run on a timer by start() below ──────────────
async function checkOfflineCounts() {
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

    const text = `🚨 <b>ALERT — ${farmName}</b>\n${counts.offline} of ${counts.total} machines are offline (excluding disabled).\nThreshold: ${OFFLINE_THRESHOLD}`;
    const spoken = `Warning. ${counts.offline} machines are offline at ${farmName}. Please be warned.`;

    console.log(`[ALERTS] ${farmName}: ${counts.offline} offline (threshold ${OFFLINE_THRESHOLD}) — sending Telegram alert`);
    const voiceOk = await sendTelegramVoice(spoken, text);
    if (!voiceOk) await sendTelegramText(text);
    await db.setSiteAlertState(farmId, counts.offline);
  }
}

let timer = null;
function start() {
  if (!telegramConfigured()) {
    console.log('[ALERTS] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — offline-machine voice alerts are disabled. See services/alerts.js for setup.');
    return;
  }
  console.log(`[ALERTS] Offline-count alerting active — checking every ${CHECK_EVERY_MS / 60000}m, threshold ${OFFLINE_THRESHOLD} offline (excluding disabled).`);
  checkOfflineCounts().catch(e => console.error('[ALERTS]', e.message));
  timer = setInterval(() => { checkOfflineCounts().catch(e => console.error('[ALERTS]', e.message)); }, CHECK_EVERY_MS);
}

module.exports = { start, checkOfflineCounts };
