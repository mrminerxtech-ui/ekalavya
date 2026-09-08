// ============================================================
// EWELINK SERVICE — App-style login (no dev account needed)
// Uses the same credentials as the eWeLink mobile/web app
// ============================================================
const https  = require('https');
const crypto = require('crypto');

// Known working App IDs from open-source eWeLink integrations
// Tried in order until one works
const APP_CONFIGS = [
  { appid: 'oeVkj2lYFkl4tb2lh3Z6n1OlAgpIZsKY', secret: '6Nz4n0xA8s8qdxQf2GqurZj2Fs55FUvM' },
  { appid: 'McFJj4Noke1mGDZCR1QarGW7P9YlW9Fl', secret: 'ApSxXnHhjnfz2ywMkI7OcM7fc22zIpAa' },
  { appid: 'YzfeftUVcZ6twZw1OoVKPRFYTrGEg01Q', secret: '4G91qSoboqYO4Y0XJ0LPPKIsq8reHdfa' },
];

const state = {
  token:     null,
  expiry:    null,
  devices:   [],
  readings:  {},
  sensorMap: {},
  appConfig: null, // which app config worked
  config: {
    email:    process.env.EWELINK_EMAIL    || '',
    password: process.env.EWELINK_PASSWORD || '',
    region:   process.env.EWELINK_REGION   || 'eu',
    appid:    process.env.EWELINK_APPID    || '',
    secret:   process.env.EWELINK_SECRET   || '',
  },
};

function regionHost(region) {
  const h = { eu: 'eu-apia.coolkit.cc', us: 'us-apia.coolkit.cc', as: 'as-apia.coolkit.cc', cn: 'cn-apia.coolkit.cc' };
  return h[region] || h.eu;
}

function sign(secret, body) {
  return crypto.createHmac('sha256', secret).update(JSON.stringify(body)).digest('base64');
}

function apiRequest(host, method, path, body, token, appid) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json', 'X-CK-Appid': appid };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request({ hostname: host, path, method, headers, timeout: 8000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ error: -1, raw: d.slice(0,200) }); } });
    });
    req.on('error', e => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

// ── Login — try each App Config until one works ───────────
async function login() {
  const { email, password, region } = state.config;
  if (!email || !password) return { error: 'Set EWELINK_EMAIL and EWELINK_PASSWORD in Railway Variables' };

  const host = regionHost(region);

  // Build list: user-supplied first, then fallbacks
  const configs = [];
  if (state.config.appid && state.config.secret) {
    configs.push({ appid: state.config.appid, secret: state.config.secret });
  }
  configs.push(...APP_CONFIGS);

  for (const cfg of configs) {
    const body = { email, password, countryCode: '+1' };
    try {
      const headers_sign = sign(cfg.secret, body);
      // Try v2 API
      const r2 = await apiRequest(host, 'POST', '/v2/user/login', body,
        null, cfg.appid).catch(() => null);
      if (r2?.error === 0 && r2.data?.accessToken) {
        state.token     = r2.data.accessToken;
        state.expiry    = Date.now() + (r2.data.atExpiredTime || 86400000);
        state.appConfig = cfg;
        console.log(`[EWELINK] ✓ Login OK (appid: ${cfg.appid.slice(0,8)}...)`);
        return { ok: true };
      }
      // Try v1 API (older format)
      const nonce = Math.random().toString(36).slice(2, 10);
      const ts    = Math.floor(Date.now() / 1000);
      const body1 = { email, password, version: 8, ts, nonce, appid: cfg.appid };
      const sign1 = crypto.createHmac('sha256', cfg.secret).update(JSON.stringify(body1)).digest('base64');
      const r1 = await apiRequest(
        'eu-api.coolkit.cc', 'POST', '/api/user/login', body1,
        null, cfg.appid
      ).catch(() => null);
      if (r1?.at) {
        state.token     = r1.at;
        state.expiry    = Date.now() + 86400000;
        state.appConfig = { ...cfg, v1: true };
        console.log(`[EWELINK] ✓ Login OK v1 (appid: ${cfg.appid.slice(0,8)}...)`);
        return { ok: true };
      }
      if (r2?.error || r1?.error) console.warn(`[EWELINK] Config ${cfg.appid.slice(0,8)} failed: ${r2?.error||r1?.error}`);
    } catch(e) { console.warn(`[EWELINK] Config error: ${e.message}`); }
  }
  return { error: 'Login failed. Check your email and password. The eWeLink API may be temporarily unavailable.' };
}

async function ensureToken() {
  if (!state.token || Date.now() > (state.expiry - 60000)) await login();
  return state.token;
}

// ── Get devices ───────────────────────────────────────────
async function getDevices() {
  const token = await ensureToken();
  if (!token || !state.appConfig) return [];
  const host = regionHost(state.config.region);
  const cfg  = state.appConfig;
  try {
    let devices = [];
    if (cfg.v1) {
      // v1 device list
      const r = await apiRequest(host, 'GET', '/api/user/device?version=8&getTags=1', null, token, cfg.appid);
      devices = (r.devicelist || []).map(d => ({
        id: d.deviceid, name: d.name, online: d.online,
        model: d.extra?.model || 'Sensor',
        temp:     d.params?.temperature ?? d.params?.currentTemperature ?? null,
        humidity: d.params?.humidity    ?? d.params?.currentHumidity    ?? null,
        params:   d.params || {},
      }));
    } else {
      // v2 device list
      const r = await apiRequest(host, 'GET', '/v2/device/thing?num=100', null, token, cfg.appid);
      if (r.error === 0 && r.data?.thingList) {
        devices = r.data.thingList
          .filter(i => i.itemType === 1)
          .map(i => {
            const d = i.itemData || i;
            const p = d.params || {};
            return {
              id: d.deviceid, name: d.name, online: d.online,
              model: d.extra?.model || d.productModel || 'Sensor',
              temp:     p.temperature ?? p.currentTemperature ?? null,
              humidity: p.humidity    ?? p.currentHumidity    ?? null,
              params: p,
            };
          });
      }
    }
    state.devices = devices.filter(d => d.id);
    console.log(`[EWELINK] ${state.devices.length} devices`);
    return state.devices;
  } catch(e) { console.error('[EWELINK] getDevices:', e.message); return []; }
}

async function refreshReadings() {
  const devices = await getDevices();
  devices.forEach(d => {
    if (d.temp !== null || d.humidity !== null) {
      state.readings[d.id] = { name: d.name, model: d.model, temp: d.temp, humidity: d.humidity, online: d.online, updated: new Date().toISOString() };
    }
  });
  return state.readings;
}

function setSensorMap(farmId, ids) { state.sensorMap[farmId] = ids; }
function getSensorMap()             { return state.sensorMap;  }
function getReadings()              { return state.readings;   }
function getDevicesState()          { return state.devices;    }
function getFarmReadings(farmId) {
  return (state.sensorMap[farmId] || []).map(id => ({ id, ...state.readings[id] })).filter(r => r.name);
}
function getConfig() {
  return { email: state.config.email, region: state.config.region, configured: !!(state.config.email && state.config.password), loggedIn: !!state.token };
}
function updateConfig(cfg) {
  Object.assign(state.config, cfg);
  state.token = null; state.expiry = null; state.appConfig = null;
}

setInterval(async () => {
  if (state.config.email) { try { await refreshReadings(); } catch(e) {} }
}, 5 * 60 * 1000);

setTimeout(async () => {
  if (state.config.email) { await refreshReadings().catch(() => {}); }
}, 10000);

module.exports = { login, getDevices, refreshReadings, setSensorMap, getSensorMap, getReadings, getFarmReadings, getConfig, updateConfig, getDevicesState };
