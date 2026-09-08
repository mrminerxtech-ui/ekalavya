const net = require('net');
const DEFAULT_PORT = parseInt(process.env.CGMINER_PORT)||4028;
const DEFAULT_TIMEOUT = parseInt(process.env.SCAN_TIMEOUT_MS)||3000;
function cgminerCommand(host, command, port=DEFAULT_PORT, timeout=DEFAULT_TIMEOUT) {
  return new Promise((resolve,reject) => {
    const socket=new net.Socket(); let data='';
    socket.setTimeout(timeout);
    socket.connect(port, host, () => socket.write(JSON.stringify({ command })+'\n'));
    socket.on('data', chunk => { data+=chunk.toString(); if(data.includes('\0')) { socket.destroy(); try { resolve(JSON.parse(data.replace(/\0/g,'').trim())); } catch(e) { reject(new Error('Parse:'+e.message)); } } });
    socket.on('timeout', () => { socket.destroy(); reject(new Error('Timeout')); });
    socket.on('error', err => { socket.destroy(); reject(err); });
  });
}
async function probeMiner(host, port=DEFAULT_PORT, timeout=DEFAULT_TIMEOUT) {
  try { const r=await cgminerCommand(host,'version',port,timeout); if(r?.STATUS) return { alive:true, api:'cgminer', raw:r }; return null; }
  catch { return null; }
}
async function getMinerStats(host, port=DEFAULT_PORT) {
  const [summary,devs,pools] = await Promise.allSettled([
    cgminerCommand(host,'summary',port), cgminerCommand(host,'devs',port), cgminerCommand(host,'pools',port)
  ]);
  return { summary:summary.status==='fulfilled'?summary.value:null, devs:devs.status==='fulfilled'?devs.value:null, pools:pools.status==='fulfilled'?pools.value:null };
}
function parseSummary(raw, host) {
  if(!raw?.SUMMARY?.[0]) return null;
  const s=raw.SUMMARY[0];
  return { ip:host, hashrate_5s:(s['MHS 5s']||0)/1000, hashrate_1m:(s['MHS 1m']||0)/1000, accepted:s['Accepted']||0, rejected:s['Rejected']||0, hardware_errors:s['Hardware Errors']||0, uptime:s['Elapsed']||0 };
}
function parseDevs(raw) {
  if(!raw?.DEVS) return [];
  return raw.DEVS.map(d=>({ id:d.ID, status:d.Status, temperature:d.Temperature||0, hashrate:(d['MHS 5s']||0)/1000, fan_speed:d['Fan Speed In']||0 }));
}
function parsePools(raw) {
  if(!raw?.POOLS) return [];
  return raw.POOLS.map(p=>({ id:p.POOL, url:p.URL, status:p.Status, accepted:p.Accepted, rejected:p.Rejected }));
}
async function sendCommand(host, command, parameter='', port=DEFAULT_PORT) {
  const payload = parameter ? JSON.stringify({ command,parameter }) : JSON.stringify({ command });
  return new Promise((resolve,reject) => {
    const socket=new net.Socket(); let data='';
    socket.setTimeout(5000);
    socket.connect(port, host, () => socket.write(payload+'\n'));
    socket.on('data', chunk => { data+=chunk.toString(); if(data.includes('}')) { socket.destroy(); try { resolve(JSON.parse(data.trim())); } catch { resolve({ ok:true }); } } });
    socket.on('timeout', () => { socket.destroy(); reject(new Error('Timeout')); });
    socket.on('error', err => { socket.destroy(); reject(err); });
  });
}
module.exports = { cgminerCommand, probeMiner, getMinerStats, parseSummary, parseDevs, parsePools, sendCommand };
