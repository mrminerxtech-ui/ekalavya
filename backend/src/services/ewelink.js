// ============================================================
// EWELINK SERVICE — OAuth2.0 (Standard app role)
// ------------------------------------------------------------
// Standard-role eWeLink apps (the only role available on personal
// dev.ewelink.cc accounts) do NOT support direct email/password
// login. Access requires the full OAuth2.0 flow:
//   1. Send the user to eWeLink's own login page (buildAuthorizeUrl)
//   2. eWeLink redirects back to us with a one-time "code"
//   3. We exchange that code, server-side, for an access token
//      (exchangeCodeForToken)
//   4. The access token expires periodically — refreshAccessToken()
//      renews it automatically using the longer-lived refresh token
// ============================================================
const https  = require('https');
const crypto = require('crypto');

const state = {
  accessToken:  null,
  refreshToken: null,
  atExpiry:     null, // access token expiry (ms timestamp)
  region:       null, // set once eWeLink tells us during the callback
  devices:      [],
  readings:     {},
  sensorMap:    {},
  config: {
    appid:       process.env.EWELINK_APPID       || '',
    secret:      process.env.EWELINK_SECRET      || '',
    redirectUrl: process.env.EWELINK_REDIRECT_URL || '',
  },
};

function updateConfig(cfg) {
  state.config = { ...state.config, ...cfg };
}

function getConfig() {
  return { ...state.config, connected: !!state.accessToken };
}

function getStatus() {
  return {
    connected: !!state.accessToken,
    region:    state.region,
    devices:   state.devices.length,
  };
}

// ── Signing helper — every eWeLink v2 API call needs a signature
// computed as base64(HMAC-SHA256(payload, appSecret)) ──────────────
function sign(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('base64');
}

// ── Step 1: build the URL to send the user's browser to ──────────
// eWeLink's authorization page lives on a fixed host regardless of
// region — the region is only revealed later, in the callback.
function buildAuthorizeUrl(stateToken) {
  const { appid, secret, redirectUrl } = state.config;
  if (!appid || !secret || !redirectUrl) {
    throw new Error('App ID, App Secret, and Redirect URL must be set first');
  }
  const seq = Date.now().toString();
  const authorization = sign(secret, appid + seq);

  const params = new URLSearchParams({
    state:        stateToken || 'ekalavya',
    clientId:     appid,
    authorization,
    seq,
    redirectUrl,
    nonce:        crypto.randomBytes(8).toString('hex'),
    grantType:    'authorization_code',
    showQRCode:   'true',
  });
  return 'https://c2ccdn.coolkit.cc/oauth/index.html?' + params.toString();
}

// ── Generic signed request to a region-specific eWeLink API host ──
function apiRequest(host, method, path, body, accessToken) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json', 'X-CK-Appid': state.config.appid };
    if (accessToken) {
      headers['Authorization'] = `Bearer ${accessToken}`;
    } else if (data) {
      headers['Authorization'] = 'Sign ' + sign(state.config.secret, data);
    }
    if (data) headers['Content-Length'] = Buffer.byteLength(data);

    const req = https.request({ hostname: host, path, method, headers, timeout: 10000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch(e) { reject(new Error('Invalid response from eWeLink: ' + d.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('eWeLink request timed out')); });
    if (data) req.write(data);
    req.end();
  });
}

// ── Step 2: exchange the one-time code for real access ────────────
async function exchangeCodeForToken(code, region) {
  const host = `${region || 'us'}-apia.coolkit.cc`;
  const body = { grantType: 'authorization_code', code, redirectUrl: state.config.redirectUrl };
  const resp = await apiRequest(host, 'POST', '/v2/user/oauth/token', body, null);

  if (resp.error && resp.error !== 0) {
    console.error('[EWELINK] Token exchange failed:', JSON.stringify(resp));
    return { error: resp.msg || resp.error || 'Token exchange failed' };
  }

  const d = resp.data || {};
  state.accessToken  = d.accessToken;
  state.refreshToken = d.refreshToken;
  state.atExpiry      = Date.now() + (d.atExpiredTime || 30 * 24 * 3600 * 1000);
  state.region        = region || 'us';
  console.log(`[EWELINK] ✓ OAuth login successful (region: ${state.region})`);
  return { ok: true };
}

// ── Step 3: renew the access token when it's close to expiring ────
async function refreshAccessToken() {
  if (!state.refreshToken) return { error: 'No refresh token — connect again' };
  const host = `${state.region || 'us'}-apia.coolkit.cc`;
  const body = { rt: state.refreshToken };
  const resp = await apiRequest(host, 'POST', '/v2/user/refresh', body, null);
  if (resp.error && resp.error !== 0) {
    console.error('[EWELINK] Token refresh failed:', JSON.stringify(resp));
    return { error: resp.msg || 'Refresh failed — please reconnect' };
  }
  const d = resp.data || {};
  state.accessToken = d.accessToken || state.accessToken;
  state.atExpiry     = Date.now() + (d.atExpiredTime || 30 * 24 * 3600 * 1000);
  console.log('[EWELINK] ✓ Access token refreshed');
  return { ok: true };
}

async function ensureToken() {
  if (!state.accessToken) return { error: 'Not connected — use Connect to eWeLink first' };
  if (state.atExpiry && Date.now() > state.atExpiry - 5 * 60 * 1000) {
    const r = await refreshAccessToken();
    if (r.error) return r;
  }
  return { ok: true };
}

// ── Device list ─────────────────────────────────────────────────
async function getDevices() {
  const ok = await ensureToken();
  if (ok.error) return ok;
  const host = `${state.region || 'us'}-apia.coolkit.cc`;
  const resp = await apiRequest(host, 'GET', '/v2/device/thing', null, state.accessToken);
  if (resp.error && resp.error !== 0) return { error: resp.msg || 'Could not fetch devices' };

  const things = (resp.data && resp.data.thingList) || [];
  state.devices = things.map(t => ({
    deviceid: t.itemData?.deviceid,
    name:     t.itemData?.name,
    online:   t.itemData?.online,
    params:   t.itemData?.params,
    extra:    t.itemData?.extra,
    // The per-device key eWeLink issues at pairing. It was being
    // discarded here, even though it's the one thing needed to talk to
    // these devices directly over the LAN — which keeps working when
    // the internet doesn't. Never included in the normal device list
    // response; see GET /api/sensors/device-keys.
    devicekey: t.itemData?.devicekey || null,
  })).filter(d => d.deviceid);

  return { ok: true, devices: state.devices };
}

function getReadings() { return state.readings; }
function getDeviceList() { return state.devices; }

// ── Farm ↔ device assignment (which sensor belongs to which farm) ──
function setSensorMap(farmId, deviceIds) {
  state.sensorMap[farmId] = deviceIds || [];
}
function getSensorMap() {
  return state.sensorMap;
}

// ── Fetch live temperature/humidity for one device from eWeLink ───
async function fetchDeviceStatus(deviceId) {
  const ok = await ensureToken();
  if (ok.error) return null;
  const host = `${state.region || 'us'}-apia.coolkit.cc`;
  try {
    const resp = await apiRequest(host, 'GET', `/v2/device/thing/status?type=1&id=${deviceId}`, null, state.accessToken);
    if (resp.error && resp.error !== 0) return null;
    const params = resp.data?.params || {};
    const temp = parseFloat(params.currentTemperature ?? params.temperature ?? '');
    const hum  = parseFloat(params.currentHumidity    ?? params.humidity    ?? '');
    return {
      temp:     isNaN(temp) ? null : temp,
      humidity: isNaN(hum)  ? null : hum,
      updated:  new Date().toISOString(),
    };
  } catch(e) {
    console.error(`[EWELINK] Status fetch failed for ${deviceId}:`, e.message);
    return null;
  }
}

// ── Refresh readings for every device assigned to any farm ────────
async function refreshReadings() {
  const allDeviceIds = Object.values(state.sensorMap).flat();
  for (const deviceId of allDeviceIds) {
    const reading = await fetchDeviceStatus(deviceId);
    if (reading) state.readings[deviceId] = reading;
  }
  return state.readings;
}

// ── Look up the current reading for whichever device(s) are
// assigned to a given farm ──────────────────────────────────────
function getFarmReadings(farmId) {
  const deviceIds = state.sensorMap[farmId] || [];
  return deviceIds.map(id => ({
    device_id: id,
    device_name: state.devices.find(d => d.deviceid === id)?.name || id,
    ...(state.readings[id] || { temp: null, humidity: null, updated: null }),
  }));
}

module.exports = {
  updateConfig, getConfig, getStatus,
  buildAuthorizeUrl, exchangeCodeForToken, refreshAccessToken,
  getDevices, getReadings, getDeviceList,
  setSensorMap, getSensorMap, refreshReadings, getFarmReadings,
};
