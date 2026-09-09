// ============================================================
// SENSORS ROUTE — eWeLink temperature & humidity
// ============================================================
const express  = require('express');
const router   = express.Router();
const { authMiddleware } = require('../middleware/auth');
const ewelink  = require('../services/ewelink');

// GET /api/sensors/status — eWeLink config status
router.get('/status', authMiddleware, (req, res) => {
  res.json({ ok: true, config: ewelink.getConfig() });
});

// POST /api/sensors/config — save eWeLink credentials
router.post('/config', authMiddleware, (req, res) => {
  const { email, password, appid, secret, region } = req.body;
  ewelink.updateConfig({ email, password, appid, secret, region: region || 'eu' });
  res.json({ ok: true, message: 'eWeLink config saved. Login will be attempted on next reading.' });
});

// POST /api/sensors/login — test connection
router.post('/login', authMiddleware, async (req, res) => {
  const result = await ewelink.login();
  if (result.ok) {
    await ewelink.getDevices();
    res.json({ ok: true, devices: ewelink.getDevicesState().length });
  } else {
    res.status(400).json({ error: result.error });
  }
});

// GET /api/sensors/devices — list all eWeLink devices
router.get('/devices', authMiddleware, async (req, res) => {
  const devices = await ewelink.getDevices();
  res.json({ ok: true, devices });
});

// GET /api/sensors/readings — all current readings
router.get('/readings', authMiddleware, (req, res) => {
  res.json({ ok: true, readings: ewelink.getReadings() });
});

// POST /api/sensors/refresh — force refresh readings
router.post('/refresh', authMiddleware, async (req, res) => {
  const readings = await ewelink.refreshReadings();
  res.json({ ok: true, readings });
});

// farm route moved to bottom

// POST /api/sensors/assign — assign sensor devices to a farm
router.post('/assign', authMiddleware, (req, res) => {
  const { farm_id, device_ids } = req.body;
  if (!farm_id) return res.status(400).json({ error: 'farm_id required' });
  ewelink.setSensorMap(farm_id, device_ids || []);
  res.json({ ok: true, farm_id, device_ids });
});

// GET /api/sensors/map — get sensor-farm assignments
router.get('/map', authMiddleware, (req, res) => {
  res.json({ ok: true, map: ewelink.getSensorMap() });
});

// POST /api/sensors/discover — send discover command to farm agent
// Accepts EITHER macs[] (preferred — ARP lookup) OR ips[] (subnet scan)
router.post('/discover', authMiddleware, (req, res) => {
  const { farm_id, macs, ips } = req.body;
  if (!farm_id || (!macs?.length && !ips?.length)) {
    return res.status(400).json({ error: 'farm_id and macs[] or ips[] required' });
  }
  const agentMgr = require('../services/agentManager');
  const sent = agentMgr.sendToAgent(farm_id, {
    type: 'sensor_discover',
    macs: macs || [],
    ips: ips || [],
    session_id: 'sd-' + Date.now(),
  });
  if (sent) {
    console.log(`[SENSOR] Discover sent to ${farm_id}: ${macs?.length || 0} MAC(s), ${ips?.length || 0} IP(s)`);
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: `Agent "${farm_id}" not connected` });
  }
});

// POST /api/sensors/agent-config — save which MACs belong to a farm (persisted)
const sensorConfigStore = {}; // farm_id → { macs: [] }
router.post('/agent-config', authMiddleware, (req, res) => {
  const { farm_id, macs } = req.body;
  if (!farm_id) return res.status(400).json({ error: 'farm_id required' });
  sensorConfigStore[farm_id] = { macs: macs || [] };
  console.log(`[SENSOR] Config saved for ${farm_id}: ${macs?.length || 0} MAC(s)`);
  res.json({ ok: true });
});

router.get('/agent-config/:farmId', authMiddleware, (req, res) => {
  res.json({ ok: true, config: sensorConfigStore[req.params.farmId] || { macs: [] } });
});

// POST /api/sensors/push — webhook from eWeLink automation OR manual entry
// Accepts: {farm_id, farm_name, temp, humidity}
const sensorCache = {}; // farm_id → {temp, humidity, updated, farm_name}

router.post('/push', (req, res) => {
  const { farm_id, farm_name, temp, humidity, device_id, device_name } = req.body;
  if (!farm_id && !device_id) return res.status(400).json({ error: 'farm_id required' });
  const key = farm_id || device_id;
  sensorCache[key] = {
    farm_id:   key,
    farm_name: farm_name || device_name || key,
    temp:      temp     != null ? parseFloat(temp)     : null,
    humidity:  humidity != null ? parseFloat(humidity) : null,
    updated:   new Date().toISOString(),
  };
  console.log(`[SENSOR] Push: ${key} → temp:${temp} humidity:${humidity}`);
  res.json({ ok: true });
});

// GET /api/sensors/farm/:farmId — readings for a farm (from push cache or eWeLink)
router.get('/farm/:farmId', authMiddleware, (req, res) => {
  const cached = sensorCache[req.params.farmId];
  if (cached) return res.json({ ok: true, farm_id: req.params.farmId, sensors: [cached] });
  // Try eWeLink
  const readings = ewelink.getFarmReadings(req.params.farmId);
  res.json({ ok: true, farm_id: req.params.farmId, sensors: readings });
});

module.exports = router;
