// ============================================================
// LANLI RS485 MODBUS RTU READER
// Reads MY16-542, 1to1-535, 1to1-288 via USB-RS485 adapter
// ============================================================
const ModbusRTU = require('modbus-serial');

const PORT     = process.env.LANLI_RS485_PORT || 'COM3';
const BAUD     = parseInt(process.env.LANLI_BAUD || '9600');
const SLAVE_IDS= (process.env.LANLI_SLAVE_IDS || '1,2,3').split(',').map(Number);
const CAB_NAMES= (process.env.LANLI_NAMES     || 'MY16-542,1to1-535,1to1-288').split(',');

// Modbus RTU register map for Lanli hydro inverters
// Input Registers — Function Code 04
const REG = {
  voltage_v:    { addr:0, scale:0.1   },
  current_a:    { addr:1, scale:0.1   },
  power_w:      { addr:2, scale:1     },
  frequency_hz: { addr:3, scale:0.01  },
  temp_c:       { addr:4, scale:1     },
  status_code:  { addr:5, scale:1     },
  energy_hi:    { addr:6, scale:1     },
  energy_lo:    { addr:7, scale:1     },
  rpm:          { addr:8, scale:1     },
  flow_rate:    { addr:9, scale:0.1   },
  dc_voltage:   { addr:10,scale:0.1   },
  dc_current:   { addr:11,scale:0.1   },
  water_level:  { addr:12,scale:0.01  },
  power_factor: { addr:13,scale:0.001 },
  alarm_code:   { addr:14,scale:1     },
};

const ALARM_BITS = {
  0x0001:'Over Voltage',   0x0002:'Under Voltage',
  0x0004:'Over Current',   0x0008:'Over Temperature',
  0x0010:'Grid Fault',     0x0020:'Turbine Overspeed',
  0x0040:'Comms Fault',    0x0080:'Short Circuit',
  0x0100:'Low Water',      0x0200:'Phase Imbalance',
};

const CABINET_MODELS = ['MY16-542','1to1-535','1to1-288'];
const RATED_W        = [542, 535, 288];

let client    = null;
let connected = false;

async function connect() {
  client = new ModbusRTU();
  try {
    await client.connectRTUBuffered(PORT, {
      baudRate: BAUD,
      dataBits: 8,
      stopBits: 1,
      parity:   'none',
    });
    client.setTimeout(3000);
    connected = true;
    console.log(`[LANLI] ✓ Connected to ${PORT} @ ${BAUD} baud`);
    return true;
  } catch(e) {
    console.error(`[LANLI] RS485 connection failed on ${PORT}: ${e.message}`);
    console.error(`[LANLI] Check: USB-RS485 adapter plugged in, COM port correct in .env`);
    connected = false;
    return false;
  }
}

async function readCabinet(slaveId, idx) {
  if (!client || !connected) return null;
  try {
    client.setID(slaveId);
    // Read 15 input registers from address 0
    const result = await client.readInputRegisters(0, 15);
    const d      = result.data;

    const power_w      = d[2];
    const alarm_code   = d[14];
    const energy_wh    = (d[6] << 16) | d[7];
    const alarms       = [];
    Object.entries(ALARM_BITS).forEach(([bit, label]) => {
      if (alarm_code & parseInt(bit)) alarms.push(label);
    });

    const model  = CAB_NAMES[idx] || CABINET_MODELS[idx] || `Cabinet ${idx+1}`;
    const rated  = RATED_W[idx] || 500;
    const power_kw = power_w / 1000;

    return {
      cabinet_id:   `cabinet-${idx+1}`,
      name:         `Cabinet ${idx+1}`,
      model,
      slave_id:     slaveId,
      port:         PORT,
      voltage_v:    d[0]  * 0.1,
      current_a:    d[1]  * 0.1,
      power_w,
      power_kw,
      frequency_hz: d[3]  * 0.01,
      temp_c:       d[4],
      status_code:  d[5],
      energy_kwh:   parseFloat((energy_wh / 1000).toFixed(3)),
      energy_wh,
      rpm:          d[8],
      flow_rate:    d[9]  * 0.1,
      dc_voltage:   d[10] * 0.1,
      dc_current:   d[11] * 0.1,
      water_level:  d[12] * 0.01,
      power_factor: d[13] * 0.001,
      alarm_code,
      alarms,
      alarm_count:  alarms.length,
      power_percent: parseFloat((power_kw / (rated/1000) * 100).toFixed(1)),
      status:       alarms.length > 0 ? 'alarm' : power_w > 0 ? 'running' : 'standby',
      source:       'modbus-rtu',
      rated_w:      rated,
      timestamp:    new Date().toISOString(),
    };
  } catch(e) {
    console.error(`[LANLI] Read error slave ${slaveId}: ${e.message}`);
    return null;
  }
}

async function readAllCabinets() {
  if (!connected) {
    const ok = await connect();
    if (!ok) return null;
  }

  const readings = {};
  for (let i = 0; i < SLAVE_IDS.length; i++) {
    const data = await readCabinet(SLAVE_IDS[i], i);
    const key  = `cabinet-${i+1}`;
    readings[key] = data
      ? { ok: true,  ...data }
      : { ok: false, error:`Cannot read Slave ID ${SLAVE_IDS[i]} on ${PORT}`, cabinet_id: key, model: CAB_NAMES[i]||CABINET_MODELS[i], name:`Cabinet ${i+1}` };
    // Small delay between reads on RS485 bus
    await new Promise(r => setTimeout(r, 100));
  }

  return readings;
}

async function listPorts() {
  // List available COM ports on Windows
  try {
    const { SerialPort } = require('serialport');
    const ports = await SerialPort.list();
    return ports.map(p => `${p.path} — ${p.manufacturer || 'Unknown'}`);
  } catch(e) {
    return ['Cannot list ports: ' + e.message];
  }
}

module.exports = { connect, readAllCabinets, readCabinet, listPorts, connected:()=>connected };
