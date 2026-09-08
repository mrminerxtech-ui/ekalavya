const net = require('net');
const { EventEmitter } = require('events');
const { probeMiner } = require('./cgminer');
const { getAntminerVersion } = require('./antminer');
const CONCURRENCY = parseInt(process.env.SCAN_CONCURRENCY)||50;
const TIMEOUT = parseInt(process.env.SCAN_TIMEOUT_MS)||2000;
const MINER_SIGNATURES = ['Antminer','Whatsminer','AvalonMiner','Goldshell','bmminer','cgminer'];
class Scanner extends EventEmitter {
  constructor() { super(); this.running=false; this.cancelled=false; this.found=[]; this.scanned=0; this.total=0; }
  static cidrToIPs(cidr) {
    const [base,bits]=cidr.split('/'); const prefix=parseInt(bits)||24; const parts=base.split('.').map(Number); const ips=[];
    if(prefix>=24) { for(let i=1;i<255;i++) ips.push(`${parts[0]}.${parts[1]}.${parts[2]}.${i}`); }
    else if(prefix>=23) { for(let b=0;b<2;b++) for(let i=1;i<255;i++) ips.push(`${parts[0]}.${parts[1]}.${parts[2]+b}.${i}`); }
    else { for(let i=1;i<255;i++) ips.push(`${parts[0]}.${parts[1]}.${parts[2]}.${i}`); }
    return ips;
  }
  static tcpProbe(host, port, timeout=TIMEOUT) {
    return new Promise(resolve => {
      const socket=new net.Socket(); socket.setTimeout(timeout);
      socket.connect(port, host, ()=>{ socket.destroy(); resolve(true); });
      socket.on('timeout',()=>{ socket.destroy(); resolve(false); });
      socket.on('error',()=>{ socket.destroy(); resolve(false); });
    });
  }
  static async httpIdentify(host) {
    return new Promise(resolve => {
      const req=require('http').get({ hostname:host, port:80, path:'/', timeout:TIMEOUT }, res => {
        let body=''; res.on('data', d=>{ body+=d; if(body.length>2000) res.destroy(); });
        res.on('end', ()=>{ const sig=MINER_SIGNATURES.find(s=>body.toLowerCase().includes(s.toLowerCase())); resolve(sig||null); });
      });
      req.on('error',()=>resolve(null)); req.on('timeout',()=>{ req.destroy(); resolve(null); });
    });
  }
  async probeIP(ip) {
    const cg=await probeMiner(ip, 4028, TIMEOUT);
    if(cg) return { ip, discovered_via:'cgminer_api', api_available:true, type:cg.raw?.VERSION?.[0]?.Type||'ASIC Miner', firmware:cg.raw?.VERSION?.[0]?.Miner||'Unknown', ports_open:[4028] };
    const port80=await Scanner.tcpProbe(ip, 80, TIMEOUT);
    if(port80) {
      const sig=await Scanner.httpIdentify(ip);
      if(sig) {
        let model=sig;
        try { const ver=await getAntminerVersion(ip); model=ver?.miner_type||sig; } catch {}
        return { ip, discovered_via:'http', api_available:true, type:model, firmware:'Unknown', ports_open:[80] };
      }
    }
    return null;
  }
  async scan(cidr, options={}) {
    this.running=true; this.cancelled=false; this.found=[]; this.scanned=0;
    const ips=Scanner.cidrToIPs(cidr); this.total=ips.length;
    this.emit('start', { total:this.total, cidr });
    const batchSize=options.concurrency||CONCURRENCY;
    for(let i=0;i<ips.length;i+=batchSize) {
      if(this.cancelled) break;
      const batch=ips.slice(i,i+batchSize);
      const results=await Promise.allSettled(batch.map(ip=>this.probeIP(ip)));
      for(let j=0;j<results.length;j++) {
        if(this.cancelled) break;
        this.scanned++;
        const result=results[j];
        if(result.status==='fulfilled'&&result.value) {
          const miner=result.value; this.found.push(miner);
          this.emit('found', miner);
        }
        this.emit('progress', { ip:batch[j], scanned:this.scanned, total:this.total, found:this.found.length, percent:Math.round(this.scanned/this.total*100) });
      }
    }
    this.running=false;
    this.emit('complete', { found:this.found, scanned:this.scanned, total:this.total });
    return this.found;
  }
  stop() { this.cancelled=true; this.running=false; this.emit('stopped', { scanned:this.scanned, found:this.found.length }); }
}
const activeScanners = new Map();
const createScanner = id => { const s=new Scanner(); activeScanners.set(id,s); return s; };
const getScanner = id => activeScanners.get(id);
const stopScanner = id => { const s=activeScanners.get(id); if(s) { s.stop(); activeScanners.delete(id); } };
module.exports = { Scanner, createScanner, getScanner, stopScanner };
