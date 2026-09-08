// ============================================================
// ALERT SERVICE
// Sends notifications via Slack, Telegram, Discord webhooks
// ============================================================
const axios = require('axios');
const store = require('./store');

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

module.exports = { raiseAlert, sendSlackAlert, sendTelegramAlert, checkWorkerThresholds };
