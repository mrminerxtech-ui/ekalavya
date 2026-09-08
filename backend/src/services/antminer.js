const http = require('http');
const DEFAULT_USER = process.env.MINER_DEFAULT_USER||'root';
const DEFAULT_PASS = process.env.MINER_DEFAULT_PASS||'root';
function antminerRequest(host, path, method='GET', body=null, user=DEFAULT_USER, pass=DEFAULT_PASS) {
  return new Promise((resolve,reject) => {
    const auth=Buffer.from(`${user}:${pass}`).toString('base64');
    const bodyStr=body?JSON.stringify(body):'';
    const options={ hostname:host, port:80, path, method, timeout:5000, headers:{ 'Authorization':`Basic ${auth}`, 'Content-Type':'application/json', ...(body?{'Content-Length':Buffer.byteLength(bodyStr)}:{}) } };
    const req=http.request(options, res => { let data=''; res.on('data', c=>data+=c); res.on('end', ()=>{ try { resolve(JSON.parse(data)); } catch { resolve({ raw:data, status:res.statusCode }); } }); });
    req.on('timeout', ()=>{ req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
    if(body) req.write(bodyStr);
    req.end();
  });
}
async function getAntminerStats(host, user=DEFAULT_USER, pass=DEFAULT_PASS) {
  for(const ep of ['/cgi-bin/stats.cgi','/cgi-bin/minerStatus.cgi']) {
    try { const data=await antminerRequest(host,ep,'GET',null,user,pass); if(data&&(data.STATS||data.miner_status)) return { endpoint:ep, data }; } catch {}
  }
  throw new Error(`Cannot reach Antminer at ${host}`);
}
async function rebootAntminer(host, user=DEFAULT_USER, pass=DEFAULT_PASS) { return antminerRequest(host,'/cgi-bin/reboot.cgi','GET',null,user,pass); }
async function getAntminerVersion(host, user=DEFAULT_USER, pass=DEFAULT_PASS) { return antminerRequest(host,'/cgi-bin/get_system_info.cgi','GET',null,user,pass); }
async function setAntminerPool(host, pools, user=DEFAULT_USER, pass=DEFAULT_PASS) {
  return antminerRequest(host,'/cgi-bin/set_miner_conf.cgi','POST',{ pools:pools.map(p=>({ url:p.url, user:p.worker||'worker', pass:p.pass||'x' })) },user,pass);
}
module.exports = { antminerRequest, getAntminerStats, rebootAntminer, getAntminerVersion, setAntminerPool };
