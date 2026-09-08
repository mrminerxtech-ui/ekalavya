// ============================================================
// WHATSMINER API CLIENT
// MicroBT Whatsminer M30S / M50 / M53 / M60
// Uses encrypted TCP API on port 4028
// ============================================================
const net  = require('net');
const crypto = require('crypto');

const DEFAULT_PORT    = 4028;
const DEFAULT_TIMEOUT = parseInt(process.env.SCAN_TIMEOUT_MS) || 3000;

/**
 * Whatsminer uses a slightly different protocol than CGMiner.
 * Recent firmware requires an token-based auth before commands.
 */
function whatsCommand(host, command, port = DEFAULT_PORT, timeout = DEFAULT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let data = '';
    socket.setTimeout(timeout);
    socket.connect(port, host, () => {
      socket.write(JSON.stringify({ cmd: command }) + '\n');
    });
    socket.on('data', chunk => {
      data += chunk.toString();
      if (data.includes('}')) {
        socket.destroy();
        try { resolve(JSON.parse(data.trim())); }
        catch { resolve({ raw: data }); }
      }
    });
    socket.on('timeout', () => { socket.destroy(); reject(new Error('Timeout')); });
    socket.on('error',   () => { socket.destroy(); reject(new Error(`Cannot reach ${host}:${port}`)); });
  });
}

/**
 * Get Whatsminer summary stats
 */
async function getWhatsminerStats(host, port = DEFAULT_PORT) {
  try {
    const [summary, edevs, pools] = await Promise.allSettled([
      whatsCommand(host, 'summary',  port),
      whatsCommand(host, 'edevs',    port),
      whatsCommand(host, 'pools',    port),
    ]);

    return {
      summary: summary.status === 'fulfilled' ? summary.value : null,
      edevs:   edevs.status   === 'fulfilled' ? edevs.value   : null,
      pools:   pools.status   === 'fulfilled' ? pools.value   : null,
    };
  } catch (e) {
    throw new Error(`Whatsminer API error on ${host}: ${e.message}`);
  }
}

/**
 * Reboot Whatsminer
 */
async function rebootWhatsminer(host, port = DEFAULT_PORT) {
  return whatsCommand(host, 'restart', port);
}

/**
 * Parse Whatsminer summary into normalized MMX format
 */
function parseWhatsminerStats(raw, host) {
  if (!raw?.summary?.SUMMARY?.[0]) return null;
  const s = raw.summary.SUMMARY[0];
  const devs = raw.edevs?.DEVS || [];

  return {
    ip:           host,
    model:        s.Type || 'Whatsminer',
    hashrate:    (s['MHS 5s']  || 0) / 1_000_000,  // MH → TH
    hashrate_1m: (s['MHS 1m']  || 0) / 1_000_000,
    accepted:     s.Accepted   || 0,
    rejected:     s.Rejected   || 0,
    uptime:       s.Elapsed    || 0,
    temperature:  devs.length  ? Math.max(...devs.map(d => d['Chip Temp Avg'] || d.Temperature || 0)) : 0,
    fan_in:       devs.length  ? devs[0]['Fan Speed In']  || 0 : 0,
    fan_out:      devs.length  ? devs[0]['Fan Speed Out'] || 0 : 0,
    boards: devs.map(d => ({
      id:          d.ID,
      hashrate:   (d['MHS 5s'] || 0) / 1_000_000,
      temperature: d['Chip Temp Avg'] || d.Temperature || 0,
      chips_ok:    d['Chip OK Num'] || 0,
      chips_total: d['Chip Num']    || 0,
    })),
  };
}

module.exports = {
  whatsCommand,
  getWhatsminerStats,
  rebootWhatsminer,
  parseWhatsminerStats,
};
