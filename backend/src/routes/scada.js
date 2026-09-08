const express = require('express');
const router  = express.Router();

const SCADA_USER = process.env.SCADA_USERNAME || '';
const SCADA_PASS = process.env.SCADA_PASSWORD || '';
const SCADA_SITE = process.env.SCADA_SITE     || 'Wafra Hydro Site';

const sessions      = new Set();
const manualReadings = {};

const CABINETS = {
  'cabinet-1': { id:'cabinet-1', name:'Cabinet 1', model:'MY16-542',  rated_w:542  },
  'cabinet-2': { id:'cabinet-2', name:'Cabinet 2', model:'1to1-535',  rated_w:535  },
  'cabinet-3': { id:'cabinet-3', name:'Cabinet 3', model:'1to1-288',  rated_w:288  },
};

// ── Login ─────────────────────────────────────────────────
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!SCADA_USER || !SCADA_PASS) {
    return res.status(503).json({ error: 'SCADA credentials not set. Add SCADA_USERNAME and SCADA_PASSWORD in Railway Variables.' });
  }
  if (username === SCADA_USER && password === SCADA_PASS) {
    const token = 'scada-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    sessions.add(token);
    setTimeout(() => sessions.delete(token), 8 * 3600 * 1000);
    console.log(`[SCADA] Login OK: ${username}`);
    return res.json({ ok: true, token, site: SCADA_SITE });
  }
  return res.status(401).json({ error: 'Invalid credentials' });
});

function auth(req, res, next) {
  const token = req.headers['x-scada-token'];
  if (!token || !sessions.has(token)) {
    return res.status(401).json({ error: 'Session expired — please login again' });
  }
  next();
}

// ── Overview ──────────────────────────────────────────────
router.get('/overview', auth, (req, res) => {
  const results = {};
  Object.entries(CABINETS).forEach(([id, cab]) => {
    const manual = manualReadings[id];
    results[id] = manual
      ? { ok: true, ...cab, ...manual }
      : { ok: false, error: 'No readings yet', ...cab };
  });
  res.json({ ok: true, site: SCADA_SITE, cabinets: results, timestamp: new Date().toISOString() });
});

// ── Manual reading ────────────────────────────────────────
router.post('/cabinets/:id/manual', auth, (req, res) => {
  const cab = CABINETS[req.params.id];
  if (!cab) return res.status(404).json({ error: 'Cabinet not found' });
  const { power_kw, voltage_v, current_a, frequency_hz, temp_c, rpm, flow_rate, water_level, notes } = req.body;
  manualReadings[req.params.id] = {
    power_kw:     parseFloat(power_kw)     || 0,
    power_w:     (parseFloat(power_kw)||0) * 1000,
    voltage_v:    parseFloat(voltage_v)    || 0,
    current_a:    parseFloat(current_a)    || 0,
    frequency_hz: parseFloat(frequency_hz) || 50,
    temp_c:       parseFloat(temp_c)       || 0,
    rpm:          parseFloat(rpm)          || 0,
    flow_rate:    parseFloat(flow_rate)    || 0,
    water_level:  parseFloat(water_level)  || 0,
    energy_kwh:   0,
    alarm_count:  0,
    alarms:       [],
    notes:        notes || '',
    status:       'running',
    source:       'manual',
    timestamp:    new Date().toISOString(),
  };
  res.json({ ok: true });
});

// ── RTU data from agent (no auth) ────────────────────────
router.post('/rtu-data', (req, res) => res.json({ ok: true }));

module.exports = router;
