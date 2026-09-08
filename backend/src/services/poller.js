const cron = require('node-cron');
const { getMinerStats, parseSummary, parseDevs, parsePools } = require('./cgminer');
const { getAntminerStats } = require('./antminer');
const { broadcast } = require('../websocket');
const store = require('./store');
let pollJob = null;
async function pollMiner(worker) {
  const t=Date.now();
  try {
    const raw=await getMinerStats(worker.ip, worker.cgminer_port||4028);
    const summary=parseSummary(raw.summary, worker.ip);
    const devs=parseDevs(raw.devs);
    if(!summary) throw new Error('Empty');
    const update={ id:worker.id, ip:worker.ip, status:'online', hashrate:summary.hashrate_5s, accepted:summary.accepted, rejected:summary.rejected, uptime:summary.uptime, boards:devs, temperature:devs.length?Math.max(...devs.map(d=>d.temperature)):0, fan_speed:devs.length?Math.max(...devs.map(d=>d.fan_speed)):0, poll_ms:Date.now()-t, last_seen:new Date().toISOString(), error:null };
    store.updateWorker(worker.id, update);
    broadcast({ type:'worker_update', data:update });
    return update;
  } catch(cgErr) {
    try {
      const result=await getAntminerStats(worker.ip);
      const parsed=result?.data;
      const update={ id:worker.id, ip:worker.ip, status:'online', hashrate:parseFloat(parsed?.rate_5s||parsed?.['GHS 5s']||0)/1000, temperature:parseFloat(parsed?.temp||0), fan_speed:parseInt(parsed?.fan_speed_in||0), poll_ms:Date.now()-t, last_seen:new Date().toISOString(), error:null, api:'http' };
      store.updateWorker(worker.id, update);
      broadcast({ type:'worker_update', data:update });
      return update;
    } catch {
      const update={ id:worker.id, ip:worker.ip, status:'offline', hashrate:0, error:cgErr.message, last_seen:new Date().toISOString(), poll_ms:Date.now()-t };
      store.updateWorker(worker.id, update);
      broadcast({ type:'worker_update', data:update });
      return update;
    }
  }
}
async function pollAll() {
  const workers=store.getWorkers(); if(!workers.length) return;
  console.log(`[POLLER] Polling ${workers.length} miners...`);
  for(let i=0;i<workers.length;i+=20) { const b=workers.slice(i,i+20); await Promise.allSettled(b.map(w=>pollMiner(w))); }
  broadcast({ type:'fleet_summary', data:store.getFleetSummary() });
}
function startAutoPoller() {
  pollJob=cron.schedule('*/30 * * * * *', ()=>{ pollAll().catch(e=>console.error('[POLLER]',e.message)); });
  setTimeout(pollAll, 5000);
  console.log('[POLLER] Started (every 30s)');
}
function stopAutoPoller() { if(pollJob) { pollJob.stop(); pollJob=null; } }
module.exports = { startAutoPoller, stopAutoPoller, pollMiner, pollAll };
