const { v4: uuidv4 } = require('uuid');
let workers = [];
let networks = [
  { id:'local', name:'Local Network', type:'direct', subnet:'192.168.1.0/24', status:'connected', latency:1, flag:'🏠' },
];
let alerts = [];
let pricesCache = null, pricesCacheTime = 0;
const getWorkers = () => workers;
const getWorker = id => workers.find(w => w.id === id);
const addWorker = data => { const w = { id:uuidv4(), status:'unknown', hashrate:0, ...data, created_at:new Date().toISOString() }; workers.push(w); return w; };
const updateWorker = (id, upd) => { const i = workers.findIndex(w => w.id === id); if(i>=0) workers[i] = {...workers[i], ...upd}; return workers[i]; };
const removeWorker = id => { workers = workers.filter(w => w.id !== id); };
const getNetworks = () => networks;
const addNetwork = d => { const n = { id:uuidv4(), status:'pending', ...d }; networks.push(n); return n; };
const removeNetwork = id => { networks = networks.filter(n => n.id !== id); };
const updateNetwork = (id, upd) => { const i = networks.findIndex(n => n.id === id); if(i>=0) networks[i] = {...networks[i], ...upd}; return networks[i]; };
const getAlerts = () => alerts.slice(0,100);
const addAlert = a => { alerts.unshift({ id:uuidv4(), ...a }); if(alerts.length>500) alerts = alerts.slice(0,500); };
const getFleetSummary = () => {
  const online = workers.filter(w => w.status==='online');
  const offline = workers.filter(w => w.status==='offline');
  const warn = workers.filter(w => w.status==='warn');
  return { total:workers.length, online:online.length, offline:offline.length, warning:warn.length,
    total_hashrate: online.reduce((a,w)=>a+(w.hashrate||0),0),
    avg_temp: online.length ? online.reduce((a,w)=>a+(w.temperature||0),0)/online.length : 0,
    total_power: online.reduce((a,w)=>a+(w.power||0),0),
    critical_alerts: alerts.filter(a=>a.level==='critical').length,
    updated_at: new Date().toISOString() };
};
const getPricesCache = () => ({ data:pricesCache, age:Date.now()-pricesCacheTime });
const setPricesCache = d => { pricesCache=d; pricesCacheTime=Date.now(); };
module.exports = { getWorkers,getWorker,addWorker,updateWorker,removeWorker, getNetworks,addNetwork,removeNetwork,updateNetwork, getAlerts,addAlert, getFleetSummary, getPricesCache,setPricesCache };
