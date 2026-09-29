// ============================================================
// EKALAVYA AGENT GUARD — one agent per PC
// ------------------------------------------------------------
// Two agents on one PC fight: with the same FARM_ID each registration
// knocks the other off the backend, and two updaters both rewrite the
// agent's files at once. The old guard was a lock FILE in the agent's
// own folder, so a second copy unzipped into another folder (Downloads
// vs C:\ekalavya-agent) never saw it, and a stale file could block a
// real start after a crash.
//
// This guard is PC-wide: the running updater and the running agent
// each hold a small listening port on 127.0.0.1 (47811 / 47812). Only
// one program on the PC can hold a port, Windows frees it the instant
// the process dies (no stale locks, no PID-reuse guessing), and any
// copy in any folder finds it. Asked, the port answers who holds it
// (farm, folder, process), so the refusal says exactly what to close.
// Loopback only: nothing is reachable from the network, and Windows
// Firewall doesn't prompt for it.
//
// Also a small command-line tool used by SETUP-WINDOWS.bat / START.bat:
//   node agent-guard.js --status        who is running (exit 0 = an agent is running)
//   node agent-guard.js --stop-others   stop every other Ekalavya agent on this PC
// ============================================================
const net  = require('net');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execSync } = require('child_process');

const APP   = 'ekalavya-agent';
const PORTS = {
  supervisor: parseInt(process.env.EKL_SUPERVISOR_LOCK_PORT || '47811', 10),
  agent:      parseInt(process.env.EKL_AGENT_LOCK_PORT      || '47812', 10),
};

// FARM_ID / FARM_NAME from the folder's .env, for messages (the updater
// doesn't load .env itself).
function readEnv(dir) {
  const out = {};
  try {
    fs.readFileSync(path.join(dir, '.env'), 'utf8').split(/\r?\n/).forEach(l => {
      const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    });
  } catch (e) {}
  return out;
}

function identity(role, dir) {
  const env = readEnv(dir);
  return {
    app: APP, role, pid: process.pid, ppid: process.ppid,
    farm_id: process.env.FARM_ID || env.FARM_ID || '', farm_name: process.env.FARM_NAME || env.FARM_NAME || '',
    dir, host: os.hostname(), started_at: new Date().toISOString(),
    via: process.env.pm_id !== undefined ? 'pm2' : (process.env.EKL_SUPERVISED === '1' ? 'updater' : 'window'),
  };
}

// Who holds this port? null = free · {foreign:true} = some other program · info = an Ekalavya agent
function probe(port, timeoutMs = 1500) {
  return new Promise(resolve => {
    let buf = '', done = false;
    const finish = v => { if (done) return; done = true; try { s.destroy(); } catch (e) {} resolve(v); };
    const s = net.connect({ host: '127.0.0.1', port });
    s.setTimeout(timeoutMs, () => finish({ foreign: true }));
    s.on('data', d => {
      buf += d.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1 && buf.length < 4096) return;
      try { const info = JSON.parse(buf.slice(0, nl === -1 ? undefined : nl)); finish(info && info.app === APP ? info : { foreign: true }); }
      catch (e) { finish({ foreign: true }); }
    });
    s.on('end', () => finish(buf ? (() => { try { const i = JSON.parse(buf); return i.app === APP ? i : { foreign: true }; } catch (e) { return { foreign: true }; } })() : { foreign: true }));
    s.on('error', e => finish(e.code === 'ECONNREFUSED' ? null : { foreign: true }));
  });
}

function listen(port, info) {
  return new Promise(resolve => {
    const srv = net.createServer(sock => { sock.on('error', () => {}); sock.end(JSON.stringify(info) + '\n'); });
    srv.once('error', e => resolve({ error: e }));
    srv.listen({ host: '127.0.0.1', port, exclusive: true }, () => { srv.unref(); resolve({ server: srv }); });
  });
}

// Take the PC-wide slot for `role`. Waits up to waitMs only for a holder
// that is its own predecessor still shutting down (an agent restarted by
// the same updater); any other holder is refused at once.
// → { ok:true } | { ok:false, other } | { ok:false, foreign:true }
async function claim(role, dir, { waitMs = 5000 } = {}) {
  const port = PORTS[role];
  const info = identity(role, dir);
  const until = Date.now() + waitMs;
  for (;;) {
    const r = await listen(port, info);
    if (r.server) return { ok: true, server: r.server, info };
    if (r.error && r.error.code !== 'EADDRINUSE' && r.error.code !== 'EACCES') return { ok: false, foreign: true, error: r.error };
    const other = await probe(port);
    if (other === null) continue;                          // freed meanwhile — try again
    if (other.foreign) return { ok: false, foreign: true };
    // Only a predecessor from the SAME updater (it just restarted us after
    // an update) is worth waiting for; anyone else is refused straight away.
    const sibling = other.ppid && other.ppid === process.ppid && other.pid !== process.pid;
    if (!sibling || Date.now() >= until) return { ok: false, other };
    await new Promise(r2 => setTimeout(r2, 500));
  }
}

function describe(o) {
  if (!o) return '';
  const farm = o.farm_name ? `${o.farm_name}${o.farm_id ? ' (' + o.farm_id + ')' : ''}` : (o.farm_id || 'unknown farm');
  const how = o.via === 'pm2' ? 'in the background (PM2)' : o.via === 'updater' ? 'under its updater' : 'in a command window';
  return `${farm} — folder ${o.dir}, process ${o.pid}, running ${how} since ${String(o.started_at || '').replace('T', ' ').slice(0, 19)}`;
}

function printRefusal(what, other) {
  const lines = [
    '',
    '  ════════════════════════════════════════════════════════════',
    `  An Ekalavya agent is ALREADY RUNNING on this PC — this ${what} will not start.`,
    '',
    '  Running: ' + describe(other),
    '',
    '  Only one agent may run per PC: two agents knock each other',
    '  offline and fight over updates.',
    '',
    other && other.via === 'pm2'
      ? '  It runs in the background already — nothing else to start.\n  Logs: pm2 logs ekl-agent'
      : '  Close that window first, or just leave it running.',
    '  ════════════════════════════════════════════════════════════',
    '',
  ];
  console.error(lines.join('\n'));
}

// ── Command line ────────────────────────────────────────────────
function pm2List() {
  try { return JSON.parse(execSync('pm2 jlist', { stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 }).toString('utf8').replace(/^[^\[]*/, '')); }
  catch (e) { return null; }
}
const OUR_SCRIPTS = /(^|[\\/])(agent|update-check)\.js$/i;

function looseNodeProcesses() {
  // node.exe processes whose command line runs agent.js / update-check.js
  try {
    if (process.platform === 'win32') {
      const ps = 'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress';
      // -EncodedCommand (UTF-16LE base64) so no quoting can break on the way through cmd
      const enc = Buffer.from(ps, 'utf16le').toString('base64');
      const out = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${enc}`, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 }).toString('utf8').trim();
      if (!out) return [];
      const arr = [].concat(JSON.parse(out));
      return arr.map(p => ({ pid: p.ProcessId, cmd: p.CommandLine || '' }));
    }
    return execSync('ps -eo pid=,args=', { stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').split('\n')
      .map(l => l.trim().match(/^(\d+)\s+(.*)$/)).filter(Boolean).map(m => ({ pid: +m[1], cmd: m[2] }));
  } catch (e) { return []; }
}
function isOurScript(cmd) {
  // node <path>\agent.js or <path>\update-check.js (quoted or not)
  const parts = (String(cmd).match(/"[^"]*"|\S+/g) || []).map(p => p.replace(/^"|"$/g, ''));
  return /(^|[\\/])node(\.exe)?$/i.test(parts[0] || '') && parts.slice(1).some(p => OUR_SCRIPTS.test(p));
}

async function cli(argv) {
  if (argv.includes('--status')) {
    const sup = await probe(PORTS.supervisor), ag = await probe(PORTS.agent);
    const mine = [sup, ag].filter(x => x && !x.foreign);
    if (!mine.length) { console.log('  No Ekalavya agent is running on this PC.'); return 1; }
    if (ag && !ag.foreign) console.log('  Agent running:   ' + describe(ag));
    if (sup && !sup.foreign) console.log('  Updater running: ' + describe(sup));
    return 0;
  }
  if (argv.includes('--stop-others')) {
    let stopped = 0;
    const list = pm2List();
    if (list) {
      for (const p of list) {
        const script = (p.pm2_env && p.pm2_env.pm_exec_path) || '';
        if (OUR_SCRIPTS.test(script)) {
          try { execSync(`pm2 delete ${p.pm_id}`, { stdio: 'ignore', timeout: 20000 }); stopped++; console.log(`  Stopped background agent "${p.name}" (${script})`); } catch (e) {}
        }
      }
    }
    for (const p of looseNodeProcesses()) {
      if (p.pid === process.pid || p.pid === process.ppid || !isOurScript(p.cmd)) continue;
      try { process.kill(p.pid); stopped++; console.log(`  Stopped agent process ${p.pid}: ${p.cmd.slice(0, 120)}`); } catch (e) {}
    }
    // anything still holding the slots (an agent started some other way)
    for (const role of ['supervisor', 'agent']) {
      const o = await probe(PORTS[role]);
      if (o && !o.foreign && o.pid && o.pid !== process.pid) {
        try { process.kill(o.pid); stopped++; console.log(`  Stopped ${role} process ${o.pid} (${o.dir})`); } catch (e) {}
      }
    }
    console.log(stopped ? `  ${stopped} other agent process(es) stopped.` : '  No other agent was running.');
    await new Promise(r => setTimeout(r, 1500));   // let Windows release their ports
    return 0;
  }
  console.log('Usage: node agent-guard.js --status | --stop-others');
  return 2;
}

module.exports = { claim, probe, describe, printRefusal, PORTS, isOurScript };

if (require.main === module) cli(process.argv.slice(2)).then(code => process.exit(code));
