
// ── Missing functions prepended ──────────────────────────

// API and URL setup
const API_BASE = sanitizeUrl(window.EKL_API_BASE)
  || sanitizeUrl(localStorage.getItem('ekl_api_base'))
  || 'http://localhost:3001';

// ── Coin ticker data ─────────────────────────────────────
const coins = {
  BTC: {p:67420, c:2.1,  ico:'₿', col:'#f7931a'},
  ETH: {p:3480,  c:-0.8, ico:'Ξ', col:'#627eea'},
  LTC: {p:82,    c:1.2,  ico:'Ł', col:'#bfbbbb'},
  KAS: {p:0.14,  c:3.1,  ico:'⬡', col:'#49dbc0'},
};
const CC = ['#e74c3c','#3498db','#2ecc71','#9b59b6','#e67e22','#1abc9c','#f39c12','#34495e'];

// App state
let isCustomer = false, currentUser = null, activeWid = null;
let loginTab = 'admin';
let agents = [], workers = [], customers = [];
let sensorReadings = {};
let alertsData = [];
const STORE_KEY = 'ekl_v2';
const SENSOR_KEY = 'ekl_sensors_v1';
let _fleetHash = '', _workersHash = '';
let _sensorPollInt = null;
let currentFarmId = null;
let scanning = false, scanInt = null, scanTInt = null;
let scanSecs = 0, scanFound = 0;
let currentScanSession = null, currentScanFarmId = null, currentScanFarmName = null;
let _lastScanResults = {};
let _saveTimer = null;
let scadaToken = localStorage.getItem('scada_token') || null;
let scadaData = {}, scadaRefInt = null;
let _cfgAgentId = null;
let pendingAssign = [];

const LANLI = {
  'cabinet-1': {name:'Cabinet 1', model:'MY16-542', type:'Multi-Channel Controller', rated_w:542},
  'cabinet-2': {name:'Cabinet 2', model:'1to1-535', type:'Micro-Hydro Inverter', rated_w:535},
  'cabinet-3': {name:'Cabinet 3', model:'1to1-288', type:'Micro-Hydro Inverter', rated_w:288},
};

const IDOSP_URL = 'http://www.idosp.net/idosp/login.html';

// ── Sector badge helper ───────────────────────────────────
function sdot(w){ return w.disabled||w.status==='disabled'?'dis':w.status==='offline'?'off':w.status==='warn'?'wrn':'on'; }
function detectBrand(model){ const m=(model||'').toLowerCase(); if(m.includes('antminer')||m.includes('bitmain')) return 'Bitmain'; if(m.includes('whatsminer')||m.includes('microbt')) return 'MicroBT'; if(m.includes('avalon')) return 'Canaan'; if(m.includes('goldshell')) return 'Goldshell'; return ''; }

// ── Navigation ────────────────────────────────────────────
function nav(page, el) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const pg = document.getElementById('page-' + page);
  if (pg) pg.classList.add('active');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  if (el) el.classList.add('active');
  if (page === 'scanner') populateDropdowns();
  if (page === 'workers') renderWorkers();
  if (page === 'agents') renderAgents();
  if (page === 'customers') renderCustomers();
  if (page === 'alerts') renderAlerts();
  if (page === 'pools') renderPools();
  if (page === 'profitability') renderProfit();
  if (page === 'billing') renderBilling();
  if (page === 'scada') checkScadaSession();
  if (page === 'settings') { updateFleetStat(); renderSensorEntryGrid(); }
}

function showPage(n) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const pg = document.getElementById('page-' + n);
  if (pg) pg.classList.add('active');
  if (n === 'scada') checkScadaSession();
  if (n === 'settings') { updateFleetStat(); renderSensorEntryGrid(); }
}

// ── Login tab ─────────────────────────────────────────────
function setLTab(tab, el) {
  loginTab = tab;
  document.querySelectorAll('.ltab').forEach(t => t.classList.remove('active'));
  if (el) el.classList.add('active');
  const btn = document.getElementById('lBtn');
  if (btn) { btn.className = 'login-btn ' + tab; btn.textContent = tab === 'customer' ? 'ACCESS PORTAL' : 'ACCESS PLATFORM'; }
}

// ── Render functions ──────────────────────────────────────
function renderAll(){try{renderDash();}catch(e){console.error('renderDash:',e);}try{updateNavCount();}catch(e){}}
function renderWorkers() {
  const tb = document.getElementById('workersTbody');
  if (!tb) return;
  const hash = workers.map(w => w.id + w.status + w.hashrate).join('|');
  if (hash === _workersHash) return;
  _workersHash = hash;
  const A = fid => agents.find(a => a.id === fid) || (agents.length === 1 ? agents[0] : null);
  const C = id => customers.find(x => x.id === id);
  tb.innerHTML = workers.map(w => {
    const ag = A(w.farm_id);
    const tc = w.temp >= 90 ? 'color:var(--red)' : w.temp >= 80 ? 'color:var(--warn)' : '';
    return '<tr><td><span class="sdot ' + sdot(w) + '"></span></td>'
      + '<td><div style="font-family:Exo 2,sans-serif;font-weight:600">' + w.name + '</div><div style="font-size:9px;color:var(--mute)">' + w.ip + '</div></td>'
      + '<td>' + (w.brand || '') + '</td><td>' + (w.model || '') + '</td><td>' + (w.algo || '') + '</td>'
      + '<td>' + (w.farm || agents[0]?.name || '—') + '</td>'
      + '<td>' + hrDisplay(w) + '</td>'
      + '<td style="' + tc + '">' + (w.temp > 0 ? w.temp + '°C' : '—') + '</td>'
      + '<td>' + (w.pool || '—') + '</td>'
      + '<td><span class="badge ' + (w.disabled ? 'bor' : w.status === 'online' ? 'bgn' : 'brn') + '">' + (w.disabled ? 'REPAIR' : w.status.toUpperCase()) + '</span></td>'
      + '<td><button class="abtn open-ctrl-btn" data-wid="' + w.id + '">Manage</button></td></tr>';
  }).join('') || '<tr><td colspan="11" style="text-align:center;padding:30px;color:var(--mute)">No miners yet. Scan your network to add them.</td></tr>';
}

function renderAgents() {
  const el = document.getElementById('agentGrid');
  if (!el) return;
  el.innerHTML = agents.length === 0
    ? '<div style="text-align:center;padding:40px;color:var(--mute)"><div style="font-size:32px;margin-bottom:12px">📡</div><div>No agents connected.<br>Run the agent on your farm PC to connect.</div></div>'
    : agents.map(a => '<div class="card"><div class="card-head"><span class="sdot ' + (a.online ? 'on' : 'off') + '"></span>'
      + '<div><div style="font-family:Exo 2,sans-serif;font-weight:700">' + a.name + '</div><div style="font-size:10px;color:var(--mute)">' + (a.subnet || '') + ' &middot; v' + (a.version || '1.0') + '</div></div>'
      + '<span class="badge ' + (a.online ? 'bgn' : 'brn') + '" style="margin-left:auto">' + (a.online ? 'ONLINE' : 'OFFLINE') + '</span></div>'
      + '<div class="card-body"><div class="card-row"><span class="ck">Farm ID</span><span class="cv" style="font-family:Share Tech Mono,monospace">' + a.id + '</span></div>'
      + '<div class="card-row"><span class="ck">Host</span><span class="cv">' + (a.hostname || '—') + '</span></div>'
      + '<div class="card-row"><span class="ck">Miners</span><span class="cv g">' + workers.filter(w => w.farm_id === a.id).length + '</span></div></div>'
      + '<div class="card-foot"><button class="btn btn-sm scan-btn" data-aid="' + a.id + '">&#x25B6; Scan</button>'
      + '<button class="btn btn-sm cfg-btn" data-aid="' + a.id + '" data-name="' + a.name.replace(/"/g,'') + '" data-subnet="' + (a.subnet||'').replace(/"/g,'') + '">&#x2699; IP Ranges</button>'
      + (a.online ? '' : '<button class="btn btn-sm btn-r rm-btn" data-aid="' + a.id + '">&#x2715; Remove</button>')
      + '</div></div>'
    ).join('');
  el.querySelectorAll('.scan-btn').forEach(function(b){ b.addEventListener('click',function(){ triggerScan(this.dataset.aid); }); });
  el.querySelectorAll('.cfg-btn').forEach(function(b){ b.addEventListener('click',function(){ openAgentConfig(this.dataset.aid,this.dataset.name,this.dataset.subnet); }); });
  el.querySelectorAll('.rm-btn').forEach(function(b){ b.addEventListener('click',function(){ removeAgent(this.dataset.aid); }); });
}

// Remove a stale/offline agent from the list
function removeAgent(farmId){
  var a = agents.find(function(x){ return x.id === farmId; });
  if(!a) return;
  if(a.online){ alert('This agent is online. Stop it on the farm PC first.'); return; }
  if(!confirm('Remove offline agent "' + a.name + '" (' + farmId + ')?\n\nMiners assigned to it will stay in your fleet.')) return;
  var token = localStorage.getItem('ekl_token');
  fetch(API_BASE + '/api/agents/' + encodeURIComponent(farmId), {
    method: 'DELETE',
    headers: {'Authorization': 'Bearer ' + (token||'')}
  })
  .then(function(){ 
    agents = agents.filter(function(x){ return x.id !== farmId; });
    _fleetHash = '';
    renderAgents(); populateDropdowns(); renderFleetByFarm();
    toast('✓ Agent removed', 'var(--green)');
  })
  .catch(function(e){ toast('Error: ' + e.message, 'var(--red)'); });
}

function renderCustomers() {
  const el = document.getElementById('custGrid');
  if (!el) return;
  const CC = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22','#34495e'];
  const tot = customers.reduce((a, c) => a + c.miners.length, 0);
  const el2 = document.getElementById('ctTotal'); if (el2) el2.textContent = customers.length;
  const el3 = document.getElementById('ctMiners'); if (el3) el3.textContent = tot;
  el.innerHTML = customers.length === 0
    ? '<div style="text-align:center;padding:40px;color:var(--mute)">No customers yet. Add a customer to assign miners.</div>'
    : customers.map((c, i) => {
      const col = CC[i % CC.length];
      const ini = c.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
      const myW = workers.filter(w => c.miners.includes(w.id));
      const onl = myW.filter(w => w.status === 'online').length;
      return '<div class="card"><div class="card-head"><div class="av" style="background:' + col + ';width:38px;height:38px;font-size:15px">' + ini + '</div>'
        + '<div><div style="font-family:Exo 2,sans-serif;font-weight:700;font-size:13px">' + c.name + '</div><div style="font-size:10px;color:var(--mute)">' + (c.country || '') + (c.notes ? ' &middot; ' + c.notes : '') + '</div></div>'
        + '<span class="badge ' + (c.portal ? 'bc' : 'bwn') + '" style="margin-left:auto">' + (c.portal ? 'PORTAL' : 'NO PORTAL') + '</span></div>'
        + '<div class="card-body"><div class="card-row"><span class="ck">Miners</span><span class="cv g">' + c.miners.length + '</span></div>'
        + '<div class="card-row"><span class="ck">Online</span><span class="cv g">' + onl + ' / ' + c.miners.length + '</span></div></div>'
        + '<div class="card-foot"><button class="btn btn-sm qa-btn" data-cid="' + c.id + '">&#x26CF; Assign Miners</button></div></div>';
    }).join('');
}

function renderAlerts() {
  const el = document.getElementById('allAlerts');
  if (!el) return;
  const liveAlerts = [];
  workers.forEach(w => {
    if (w.temp >= 90) liveAlerts.push({ico:'🔴', msg: w.name + ': Critical temp ' + w.temp + '°C', time: 'Live'});
    if (w.status === 'offline') liveAlerts.push({ico:'🔴', msg: w.name + ' (' + w.ip + ') offline', time: 'Live'});
    if (w.status === 'disabled') liveAlerts.push({ico:'🟠', msg: w.name + ' disabled: ' + (w.disabled_reason || 'Repair'), time: w.disabled_at || '—'});
  });
  agents.forEach(a => { if (!a.online) liveAlerts.push({ico:'🟡', msg: 'Agent offline: ' + a.name, time: 'Live'}); });
  const all = [...liveAlerts, ...alertsData];
  const badge = document.getElementById('alertBadge'); if (badge) { badge.textContent = all.length; badge.style.display = all.length ? '' : 'none'; }
  el.innerHTML = all.length === 0
    ? '<div style="text-align:center;padding:30px;color:var(--mute)">No alerts. All systems normal.</div>'
    : all.map(a => '<div style="padding:10px 16px;border-bottom:1px solid rgba(26,42,58,.4);display:flex;gap:8px"><span style="font-size:14px">' + a.ico + '</span><div><div style="font-size:12px;color:var(--txt)">' + a.msg + '</div><div style="font-size:10px;color:var(--mute)">' + a.time + '</div></div></div>').join('');
}

function renderPools() {
  const el = document.getElementById('poolsGrid');
  if (!el) return;
  el.innerHTML = '<div style="text-align:center;padding:30px;color:var(--mute)">Pool data available after connecting miners.</div>';
}

function renderProfit() {
  const el = document.getElementById('profitGrid');
  if (!el) return;
  el.innerHTML = '<div style="text-align:center;padding:30px;color:var(--mute)">Add miners to see profitability calculations.</div>';
}

function renderBilling() {
  const el = document.getElementById('billingTable');
  if (!el) return;
}

function renderPortal() {
  try { renderDash(); } catch(e) {}
}

// ── Populate scanner dropdowns ────────────────────────────
function populateDropdowns() {
  const sv = document.getElementById('scanVia');
  if (!sv) return;
  const cur = sv.value;
  var html = '<option value="local">&#x1F4BB; Select a farm agent...</option>';
  agents.forEach(function(a){
    html += '<option value="' + a.id + '"' + (cur === a.id ? ' selected' : '') + '>'
         +  (a.online ? '\u2713 ' : '\u2717 ') + a.name + ' (' + a.id + ')</option>';
  });
  sv.innerHTML = html;
  // Restore selection if it still exists
  if (cur && agents.find(function(a){ return a.id === cur; })) sv.value = cur;
}

// ── Scanner log ───────────────────────────────────────────
function addLog(type, msg, overwrite) {
  const el = document.getElementById('scanLog');
  if (!el) return;
  const c = type === 'err' ? 'var(--red)' : type === 'ok' ? 'var(--green)' : 'var(--cyan)';
  const div = '<div id="scanlog-live" style="font-size:11px;color:' + c + ';margin-bottom:2px">' + msg + '</div>';
  if (overwrite) { const live = el.querySelector('#scanlog-live'); if (live) { live.outerHTML = div; return; } }
  el.innerHTML += div;
  el.scrollTop = el.scrollHeight;
}

// ── Filter workers by farm ────────────────────────────────
function filterByFarm(farmId) {
  return farmId === 'all' ? workers : workers.filter(w => w.farm_id === farmId);
}

// ── Miner control panel ───────────────────────────────────
function openCtrl(wid) {
  const w = workers.find(x => x.id === wid);
  if (!w) return;
  activeWid = wid;
  const el = document.getElementById('ctrlPanel');
  if (!el) return;
  // Fill in miner details
  const nm = document.getElementById('ctrlName'); if (nm) nm.textContent = w.name;
  const ip = document.getElementById('ctrlIp');   if (ip) ip.textContent = w.ip;
  const md = document.getElementById('ctrlModel');if (md) md.textContent = (w.brand||'') + ' ' + (w.model||'');
  el.style.display = 'flex';
}
function closeCtrl() { const el = document.getElementById('ctrlPanel'); if (el) el.style.display = 'none'; activeWid = null; }
function refreshCtrl() { if (activeWid) openCtrl(activeWid); }

// ── Quick assign ──────────────────────────────────────────
function quickAssign(cid) {
  const sh = document.getElementById('assignSheet');
  if (sh) { document.getElementById('assignSel').value = cid; renderAssign(); openSheet('assignSheet'); }
}
function renderAssign() {
  const cid = document.getElementById('assignSel')?.value;
  const p   = document.getElementById('assignPanel');
  if (!cid || !p) { if (p) p.style.display = 'none'; return; }
  p.style.display = 'block';
  const c = customers.find(x => x.id === cid);
  pendingAssign = [...(c?.miners || [])];
  redrawAssign(cid);
}
function redrawAssign(cid) {
  const l = document.getElementById('assignList');
  if (!l) return;
  l.innerHTML = workers.map(function(w) {
    var isA  = pendingAssign.includes(w.id);
    var other = customers.find(function(c){ return c.id !== cid && c.miners.includes(w.id); });
    return '<div class="assign-row' + (isA ? ' assigned' : '') + '" data-wid="' + w.id + '" data-cid="' + cid + '" data-locked="' + (other?'1':'0') + '">'
      + '<input type="checkbox" style="accent-color:var(--cyan)" ' + (isA ? 'checked' : '') + (other ? ' disabled' : '') + '/>'
      + '<span class="sdot ' + sdot(w) + '"></span>'
      + '<div style="flex:1"><div style="font-size:12px;font-family:Exo 2,sans-serif;font-weight:600">' + w.name + '</div>'
      + '<div style="font-size:10px;color:var(--mute)">' + w.ip + ' &middot; ' + hrDisplay(w) + '</div></div>'
      + (other ? '<span class="badge bwn" style="font-size:9px">' + other.name.split(' ')[0] + '</span>' : '') + '</div>';
  }).join('');
  l.querySelectorAll('.assign-row').forEach(function(row){
    if(row.dataset.locked==='1') return;
    row.addEventListener('click', function(){ toggleAssign(this.dataset.wid, this.dataset.cid); });
  });
  var cnt = document.getElementById('assignCount'); if (cnt) cnt.textContent = pendingAssign.length + ' miners selected';
}
function toggleAssign(wid, cid) {
  if (pendingAssign.includes(wid)) pendingAssign = pendingAssign.filter(x => x !== wid);
  else pendingAssign.push(wid);
  redrawAssign(cid);
}
function applyAssign() {
  const cid = document.getElementById('assignSel')?.value;
  const c   = customers.find(x => x.id === cid);
  if (!c) return;
  customers.forEach(x => { if (x.id !== cid) x.miners = x.miners.filter(id => !pendingAssign.includes(id)); });
  c.miners = [...pendingAssign];
  saveFleet();
  toast('✓ ' + c.name + ': ' + pendingAssign.length + ' miners assigned', 'var(--green)');
  renderCustomers(); renderWorkers(); renderDash();
}

// ── Overlay / sheet helpers ───────────────────────────────
function openOverlay(id) { const el = document.getElementById(id); if (el) el.classList.add('show'); }
function closeOverlay()   { document.querySelectorAll('.overlay.show').forEach(el => el.classList.remove('show')); }
function openSheet(id)    { const el = document.getElementById(id); if (el) el.classList.add('show'); }
function closeSheet(id)   { const el = document.getElementById(id); if (el) el.classList.remove('show'); }

// ── Toast notification ────────────────────────────────────
function toast(msg, color) {
  let t = document.getElementById('toastEl');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toastEl';
    t.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);padding:10px 18px;border-radius:20px;font-size:12px;font-family:Exo 2,sans-serif;font-weight:600;z-index:9999;transition:opacity .3s;background:var(--s1);border:1px solid var(--b2);color:var(--txt);max-width:90vw;text-align:center;pointer-events:none';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.borderColor = color || 'var(--b2)';
  t.style.color = color || 'var(--txt)';
  t.style.opacity = '1';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.opacity = '0'; }, 3000);
}

// ── Nav count badge ───────────────────────────────────────
function updateNavCount() {
  const b = document.getElementById('workerNavCount');
  if (b) b.textContent = workers.length > 0 ? workers.length : '';
}

// ── checkApiSetup ─────────────────────────────────────────
function checkApiSetup() {
  if (API_BASE.includes('localhost')) {
    const bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#ff2d55;color:#fff;padding:10px 16px;z-index:9000;display:flex;align-items:center;gap:10px;font-size:12px;font-family:Exo 2,sans-serif';
    const inp = document.createElement('input');
    inp.id = 'quickUrl'; inp.placeholder = 'https://ekalavya-backend.up.railway.app';
    inp.style.cssText = 'flex:1;padding:5px 10px;border-radius:4px;border:none;font-size:11px;';
    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save';
    saveBtn.style.cssText = 'padding:5px 12px;border-radius:4px;border:none;background:#060a0f;color:#fff;cursor:pointer;font-weight:700';
    saveBtn.onclick = function(){ setApiBase(document.getElementById('quickUrl').value); };
    bar.innerHTML = '\u26a0 <strong>Setup needed:</strong> Enter your Railway URL \u2192 ';
    bar.appendChild(inp); bar.appendChild(saveBtn);
    document.body.appendChild(bar);
  }
}

function setApiBase(v) {
  if (v && v.trim()) {
    v = sanitizeUrl(v.trim());
    localStorage.setItem('ekl_api_base', v);
    window.location.reload();
  }
}

// ── Fetch agents ──────────────────────────────────────────
function fetchAgents() {
  if (!API_BASE || API_BASE.includes('localhost')) return;
  fetch(API_BASE + '/api/agents')
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(d){
      if (!d || !d.agents) return;
      // Deduplicate by farm ID — keep the online one if duplicates exist
      var seen = {};
      d.agents.forEach(function(a){
        if (!seen[a.id] || (a.online && !seen[a.id].online)) seen[a.id] = a;
      });
      agents = Object.values(seen);
      updateAgentUI();
    })
    .catch(function(){});
}

function updateAgentUI() {
  const pillTxt = document.getElementById('agentPillTxt');
  const online = agents.filter(function(a){ return a.online; }).length;
  if (pillTxt) pillTxt.textContent = online + ' Agent' + (online !== 1 ? 's' : '');

  // Re-match any workers whose farm_id doesn't match a connected agent,
  // but whose stored farm NAME does — fixes miners appearing as Unassigned
  var changed = false;
  workers.forEach(function(w){
    if (agents.find(function(a){ return a.id === w.farm_id; })) return; // already matched
    var byName = agents.find(function(a){
      return a.name && w.farm && a.name.toLowerCase() === w.farm.toLowerCase();
    });
    if (byName) { w.farm_id = byName.id; w.farm = byName.name; changed = true; }
  });
  if (changed) { saveFleet(); _fleetHash = ''; _workersHash = ''; }

  populateDropdowns();
  if (document.getElementById('fleetByFarm')) renderFleetByFarm();
  if (document.getElementById('workersTbody')) renderWorkers();
  if (document.getElementById('agentGrid')) renderAgents();
}

// ── Trigger scan from agents page ────────────────────────
function triggerScan(farmId) {
  const agent = agents.find(a => a.id === farmId);
  if (!agent) return;
  nav('scanner', null);
  setTimeout(() => {
    const sv = document.getElementById('scanVia');
    if (sv) { sv.value = farmId; onAgentSelect(sv); }
  }, 200);
}

// ── Agent config panel ────────────────────────────────────
function getAgentSubnets(farmId) { try { return JSON.parse(localStorage.getItem('agent_subnets_' + farmId) || '[]'); } catch { return []; } }
function setAgentSubnets(farmId, subnets) {
  localStorage.setItem('agent_subnets_' + farmId, JSON.stringify(subnets));
  const a = agents.find(x => x.id === farmId); if (a) a.subnet = subnets.join(',');
  const token = localStorage.getItem('ekl_token');
  if (token && API_BASE && !API_BASE.includes('localhost')) {
    fetch(API_BASE + '/api/fleet/agent-config', { method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+token}, body:JSON.stringify({farm_id:farmId, subnets, name:a?.name||farmId}) }).catch(() => {});
  }
}
function openAgentConfig(farmId, farmName, currentSubnet) {
  _cfgAgentId = farmId;
  const t = document.getElementById('cfgAgentTitle'); if (t) t.textContent = '&#x2699; ' + farmName + ' — IP Ranges';
  const saved = getAgentSubnets(farmId);
  const display = saved.length > 0 ? saved : (currentSubnet ? currentSubnet.split(',') : []);
  const el = document.getElementById('cfgSubnets'); if (el) el.value = display.join('\n');
  const th16El = document.getElementById('cfgTH16'); if (th16El) th16El.value = localStorage.getItem('th16_sensors_' + farmId) || '';
  const panel = document.getElementById('agentScanConfig'); if (panel) { panel.style.display = 'block'; panel.scrollIntoView({behavior:'smooth'}); }
}
function appendCfgSubnet(s) { const el = document.getElementById('cfgSubnets'); if (!el) return; const cur = el.value.trim(); if (!cur.includes(s)) el.value = cur ? (cur + '\n' + s) : s; }
function saveAgentSubnets() {
  if (!_cfgAgentId) return;
  const raw = document.getElementById('cfgSubnets')?.value || '';
  const subnets = raw.split(/[,\n]+/).map(s => s.trim()).filter(Boolean);
  if (!subnets.length) { alert('Enter at least one IP range'); return; }
  setAgentSubnets(_cfgAgentId, subnets);
  const th16 = document.getElementById('cfgTH16')?.value.trim();
  if (th16) localStorage.setItem('th16_sensors_' + _cfgAgentId, th16);
  toast('✓ Config saved', 'var(--green)');
}
function scanFromConfig() {
  if (!_cfgAgentId) return;
  saveAgentSubnets();
  const subnets = getAgentSubnets(_cfgAgentId);
  const sr = document.getElementById('scanRange'); if (sr) sr.value = subnets.join('\n');
  const sv = document.getElementById('scanVia'); if (sv) sv.value = _cfgAgentId;
  nav('scanner', null);
  toast('Agent and ranges loaded — click Scan', 'var(--cyan)');
}

// ── onAgentSelect ─────────────────────────────────────────
function onAgentSelect(sel) {
  // Accept element, or fall back to reading the dropdown directly
  if (!sel || typeof sel.value === 'undefined') sel = document.getElementById('scanVia');
  if (!sel) return;
  const farmId = sel.value;
  const el = document.getElementById('scanRange');
  if (!farmId || farmId === 'local') { if (el) el.value = ''; return; }
  if (el) el.value = '';
  const saved = getAgentSubnets(farmId);
  const agent = agents.find(a => a.id === farmId);
  if (saved.length > 0) el.value = saved.join('\n');
  else if (agent?.subnet && agent.subnet !== '192.168.1.0/24') el.value = agent.subnet.split(',').join('\n');
  updateScanAgentBanner(farmId, agent);
}
function updateScanAgentBanner(farmId, agent) {
  let b = document.getElementById('scanAgentBanner');
  if (!b) { b = document.createElement('div'); b.id = 'scanAgentBanner'; b.style.cssText = 'border-radius:6px;padding:8px 12px;font-size:11px;margin-bottom:10px;display:flex;align-items:center;gap:8px'; const ref = document.getElementById('scanRange'); if (ref?.parentElement) ref.parentElement.insertBefore(b, ref); }
  if (!agent) { b.style.display = 'none'; return; }
  b.style.display = 'flex';
  b.style.background = agent.online ? 'rgba(0,255,157,.06)' : 'rgba(255,45,85,.06)';
  b.style.border = '1px solid ' + (agent.online ? 'rgba(0,255,157,.3)' : 'rgba(255,45,85,.3)');
  b.innerHTML = '<span class="sdot ' + (agent.online ? 'on' : 'off') + '"></span><span style="font-family:Exo 2,sans-serif;font-weight:700;color:var(--txt)">' + agent.name + '</span><span style="color:var(--mute)">' + (agent.online ? 'Online' : 'OFFLINE') + '</span><span style="font-family:Share Tech Mono,monospace;font-size:10px;color:var(--mute);margin-left:auto">' + (agent.subnet || '') + '</span>';
}

// ── Sensor reading storage ────────────────────────────────
function loadSensors() { try { const r = localStorage.getItem(SENSOR_KEY); if (r) sensorReadings = JSON.parse(r); } catch {} }
function saveSensors() { try { localStorage.setItem(SENSOR_KEY, JSON.stringify(sensorReadings)); } catch {} }
function getSensorReading(farmId) { return sensorReadings[farmId] || null; }
function setSensorReading(farmId, data) { sensorReadings[farmId] = {...data, updated: new Date().toISOString()}; saveSensors(); }

function initSensors() { loadSensors(); }

function renderSensorEntryGrid() {
  const el = document.getElementById('sensorEntryGrid');
  if (!el) return;
  const farms = agents.length > 0 ? agents : [{id:'ghummadh',name:'Ghummadh'},{id:'alhayer',name:'Al Hayer'},{id:'hydro',name:'Hydro'}];
  el.innerHTML = farms.map(f => {
    const r = getSensorReading(f.id) || {};
    return '<div style="background:var(--s2);border:1px solid var(--b1);border-radius:8px;padding:12px">'
      + '<div style="font-family:Exo 2,sans-serif;font-weight:700;font-size:12px;color:var(--txt);margin-bottom:10px">📍 ' + f.name + (r.updated ? '<span style="font-size:9px;color:var(--mute);font-weight:400;float:right">' + new Date(r.updated).toLocaleTimeString() + '</span>' : '') + '</div>'
      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">'
      + '<div><div style="font-size:9px;color:var(--mute);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Temperature (°C)</div>'
      + '<div style="display:flex;align-items:center;gap:4px"><span style="font-family:Share Tech Mono,monospace;font-size:24px;color:var(--warn)">' + (r.temp != null ? r.temp : '—') + '</span>'
      + '<input id="st_' + f.id + '" type="number" step="0.1" value="' + (r.temp != null ? r.temp : '') + '" placeholder="42.5" style="width:70px;background:var(--bg);border:1px solid var(--b1);border-radius:4px;padding:5px 8px;color:var(--txt);font-family:Share Tech Mono,monospace;font-size:12px;outline:none"></div></div>'
      + '<div><div style="font-size:9px;color:var(--mute);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Humidity (%)</div>'
      + '<div style="display:flex;align-items:center;gap:4px"><span style="font-family:Share Tech Mono,monospace;font-size:24px;color:var(--cyan)">' + (r.humidity != null ? r.humidity : '—') + '</span>'
      + '<input id="sh_' + f.id + '" type="number" step="1" value="' + (r.humidity != null ? r.humidity : '') + '" placeholder="35" style="width:70px;background:var(--bg);border:1px solid var(--b1);border-radius:4px;padding:5px 8px;color:var(--txt);font-family:Share Tech Mono,monospace;font-size:12px;outline:none"></div></div></div>'
      + '<button class="btn btn-sm btn-g sensor-save-btn" data-fid="' + f.id + '" data-fname="' + f.name + '">&#x1F4BE; Save</button></div>';
  }).join('');
  el.querySelectorAll('.sensor-save-btn').forEach(function(b){ b.addEventListener('click', function(){ saveSensorEntry(this.dataset.fid, this.dataset.fname); }); });
  var wh = document.getElementById('webhookUrl');
  if (wh) wh.textContent = (API_BASE || '') + '/api/sensors/push';
}

function saveSensorEntry(farmId, farmName) {
  const t = document.getElementById('st_' + farmId)?.value;
  const h = document.getElementById('sh_' + farmId)?.value;
  if (t === '' && h === '') { toast('Enter temperature or humidity', 'var(--warn)'); return; }
  setSensorReading(farmId, {temp: t !== '' ? parseFloat(t) : null, humidity: h !== '' ? parseFloat(h) : null, name: farmName});
  const token = localStorage.getItem('ekl_token');
  if (token && API_BASE && !API_BASE.includes('localhost')) {
    fetch(API_BASE + '/api/sensors/push', { method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+token}, body:JSON.stringify({farm_id:farmId, farm_name:farmName, temp:parseFloat(t)||null, humidity:parseFloat(h)||null}) }).catch(() => {});
  }
  renderSensorEntryGrid();
  toast('✓ Saved for ' + farmName, 'var(--green)');
}

function copyWebhook() {
  const url = (API_BASE || '') + '/api/sensors/push';
  if (navigator.clipboard) navigator.clipboard.writeText(url).then(() => toast('Webhook URL copied', 'var(--green)')).catch(() => {});
}

// ── Fleet stat for settings page ─────────────────────────
function updateFleetStat() {
  const el = document.getElementById('fleetStoreStat');
  if (!el) return;
  el.textContent = workers.length + ' workers · ' + customers.length + ' customers';
  const token = localStorage.getItem('ekl_token');
  if (token && API_BASE && !API_BASE.includes('localhost')) {
    fetch(API_BASE + '/api/fleet/status', {headers:{'Authorization':'Bearer '+token}})
      .then(r => r.json()).then(d => { if (d.ok) el.innerHTML += ' · <span style="color:var(--green)">✓ ' + d.storage + '</span>'; }).catch(() => {});
  }
}

function exportFleet() {
  const data = JSON.stringify({workers, customers, exported: new Date().toISOString(), v:1}, null, 2);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], {type:'application/json'}));
  a.download = 'ekalavya-fleet-' + new Date().toISOString().slice(0,10) + '.json';
  a.click();
  toast('✓ Fleet exported', 'var(--green)');
}

function importFleet(e) {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const d = JSON.parse(ev.target.result);
      if (!d.workers) throw new Error('Invalid format');
      if (!confirm('Import ' + d.workers.length + ' workers and ' + (d.customers?.length||0) + ' customers?')) return;
      workers = d.workers; customers = d.customers || [];
      saveFleet(); saveFleetToBackend(); renderAll();
      toast('✓ Imported ' + workers.length + ' workers', 'var(--green)');
    } catch(err) { alert('Import failed: ' + err.message); }
  };
  reader.readAsText(file);
  e.target.value = '';
}

// ── Add customer ──────────────────────────────────────────
function togglePortalFields() { const el = document.getElementById('portalFields'); if (el) el.style.display = document.getElementById('cPortalToggle')?.checked ? 'block' : 'none'; }
function addCustomer() {
  const n = document.getElementById('cName')?.value.trim();
  if (!n) { alert('Customer name required'); return; }
  const hasPortal = document.getElementById('cPortalToggle')?.checked;
  const email = hasPortal ? (document.getElementById('cEmail')?.value.trim() || '') : '';
  const pass  = hasPortal ? (document.getElementById('cPass')?.value || '') : '';
  if (hasPortal && !email) { alert('Email required for portal access'); return; }
  const c = { id:'cust-'+Date.now(), name:n, email, country:document.getElementById('cCountry')?.value||'', notes:document.getElementById('cNotes')?.value||'', plan:'Standard', rate:0, miners:[], active:true, portal:hasPortal };
  customers.push(c);
  closeSheet('addCustSheet');
  ['cName','cEmail','cPass','cCountry','cNotes'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const pt = document.getElementById('cPortalToggle'); if (pt) pt.checked = false;
  togglePortalFields();
  saveFleet(); saveFleetToBackend(); renderAll();
  toast(hasPortal ? '✓ Customer added with portal' : '✓ Customer added', 'var(--green)');
}

// ── Delete miner ──────────────────────────────────────────
function deleteMiner(wid) {
  if (!confirm('Remove this miner from fleet?')) return;
  workers = workers.filter(x => x.id !== wid);
  customers.forEach(c => { c.miners = c.miners.filter(x => x !== wid); });
  saveFleet();
  closeCtrl();
  renderWorkers(); renderDash();
}

// ── Disable / enable ──────────────────────────────────────
function disableMiner(reason) {
  if (!activeWid) return;
  const w = workers.find(x => x.id === activeWid);
  if (!w) return;
  w.status = 'disabled'; w.disabled = true; w.disabled_reason = reason; w.hashrate = 0;
  w.disabled_at = new Date().toISOString().slice(0,10);
  saveFleet();
  toast('🚫 ' + w.name + ' disabled', 'var(--orange)');
  refreshCtrl(); renderWorkers(); renderDash();
}
function enableMiner() {
  if (!activeWid) return;
  const w = workers.find(x => x.id === activeWid);
  if (!w) return;
  w.disabled = false; w.disabled_reason = ''; w.disabled_at = null; w.status = 'online';
  saveFleet();
  toast('✅ ' + w.name + ' enabled', 'var(--green)');
  refreshCtrl(); renderWorkers(); renderDash();
}

// ── Saved indicator ───────────────────────────────────────
function showSavedIndicator() {
  let dot = document.getElementById('savedDot');
  if (!dot) {
    dot = document.createElement('div');
    dot.id = 'savedDot';
    dot.style.cssText = 'position:fixed;bottom:70px;right:12px;z-index:999;background:rgba(0,255,157,.15);border:1px solid var(--green);border-radius:20px;padding:4px 10px;font-size:10px;color:var(--green);font-family:Share Tech Mono,monospace;pointer-events:none;transition:opacity .5s';
    document.body.appendChild(dot);
  }
  dot.textContent = '✓ Saved (' + workers.length + ' miners)';
  dot.style.opacity = '1';
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => { dot.style.opacity = '0'; }, 3000);
}

// ── addAllToFleet ─────────────────────────────────────────
function addAllToFleet() {
  const farmId   = currentScanFarmId   || (agents.length > 0 ? agents[0].id : 'unknown');
  const farmName = currentScanFarmName || agents.find(a => a.id === farmId)?.name || 'Farm';
  const miners   = Object.values(_lastScanResults);
  if (!miners.length) { toast('No scan results to add', 'var(--warn)'); return; }
  miners.forEach(m => {
    const algo   = m.algo || getAlgoFromModel(m.model || '');
    const brand  = m.brand || detectBrand(m.model || '');
    const ghA    = ['Scrypt','KHeavyHash','X11','Blake2B','Ethash','Equihash'];
    const hrUnit = m.hr_unit || (ghA.includes(algo) ? 'GH/s' : 'TH/s');
    workers = workers.filter(w => w.ip !== m.ip);
    workers.push({ id:'w-'+m.ip.replace(/\./g,'-'), name:m.worker?m.worker.split('.').pop():m.ip.replace(/\./g,'-'), model:m.model||'ASIC Miner', brand, algo, ip:m.ip, hashrate:m.hashrate||0, hr_unit:hrUnit, hr_display:m.hr_display||'—', temp:m.temp||0, fan:m.fan||0, power:m.power||0, status:'online', pool:m.pool||'—', pool_url:m.pool||'', pool_user:m.worker||'', uptime:m.uptime||'—', farm:farmName, farm_id:farmId, cid:'', disabled:false, led:false, firmware:m.firmware||'—', accepted:m.accepted||0, rejected:m.rejected||0, hw_errors:m.hw_errors||0, source:'scan', added_at:new Date().toISOString() });
  });
  saveFleet(); updateNavCount(); showSavedIndicator(); setTimeout(saveFleetToBackend, 500);
  try { renderAll(); } catch(e) {}
  toast('✓ ' + miners.length + ' miners saved to ' + farmName, 'var(--green)');
}

// ── getCabIp ──────────────────────────────────────────────
function getCabIp(id) { return localStorage.getItem('scada_ip_' + id) || ''; }
function saveCabIp(id) {
  const ip = document.getElementById('cabip_' + id)?.value.trim();
  if (!ip) { alert('Enter IP'); return; }
  localStorage.setItem('scada_ip_' + id, ip);
  fetch(API_BASE + '/api/scada/cabinets/' + id + '/config', { method:'POST', headers:{'Content-Type':'application/json','x-scada-token':scadaToken}, body:JSON.stringify({ip, port:502}) }).then(() => { toast('✓ ' + LANLI[id].model + ' → ' + ip, 'var(--green)'); scadaRefresh(); });
}
function renderCabIpConfig() {
  const el = document.getElementById('cabIpConfig');
  if (!el) return;
  el.innerHTML = Object.entries(LANLI).map(([id, cab]) =>
    '<div style="background:var(--s2);border:1px solid var(--b1);border-radius:8px;padding:12px">'
    + '<div style="font-family:Orbitron,sans-serif;font-size:11px;font-weight:700;color:var(--cyan)">' + cab.model + '</div>'
    + '<div style="font-size:10px;color:var(--mute);margin-bottom:8px">' + cab.name + ' &middot; ' + cab.rated_w + 'W</div>'
    + '<div style="display:flex;gap:6px"><input id="cabip_' + id + '" value="' + getCabIp(id) + '" placeholder="192.168.x.x" style="flex:1;background:var(--bg);border:1px solid var(--b1);border-radius:4px;padding:7px 10px;color:var(--txt);font-family:Share Tech Mono,monospace;font-size:11px;outline:none">'
    + '<button class="btn btn-sm btn-g save-cab-btn" data-cabid="' + id + '">Save</button></div></div>'
  ).join('');
  el.querySelectorAll('.save-cab-btn').forEach(function(b){ b.addEventListener('click', function(){ saveCabIp(this.dataset.cabid); }); });
}

// ── iDOSP ─────────────────────────────────────────────────
function openIdospTab() { window.open(IDOSP_URL, '_blank'); }
function loadIdosp() { openIdospTab(); }
function reloadSpFrame() { openIdospTab(); }
function openSpCloud() { openIdospTab(); }
function saveSpUrl() { openIdospTab(); }
function loadSpFrame() { openIdospTab(); }

// ── Misc ──────────────────────────────────────────────────
function logout() {
  isCustomer = false; currentUser = null;
  localStorage.removeItem('ekl_token');
  document.getElementById('loginScreen').style.display = 'flex';
  ['ticker','topbar','appBody','bottomNav'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
}

function stopScan() {
  scanning = false;
  clearInterval(scanInt); clearInterval(scanTInt);
  const btn = document.getElementById('scanBtn'); if (btn) btn.textContent = '▶ Scan Network';
  const ssl = document.getElementById('scanCurrentSubnet'); if (ssl) { ssl.style.display = 'none'; ssl.textContent = ''; }
}

function loadAgentConfigsFromBackend() {
  const token = localStorage.getItem('ekl_token');
  if (!token || !API_BASE || API_BASE.includes('localhost')) return;
  fetch(API_BASE + '/api/fleet/agent-configs', {headers:{'Authorization':'Bearer '+token}})
    .then(r => r.ok ? r.json() : null)
    .then(d => { if (!d?.configs) return; d.configs.forEach(cfg => { if (cfg.subnets?.length > 0) { localStorage.setItem('agent_subnets_' + cfg.farm_id, JSON.stringify(cfg.subnets)); const a = agents.find(x => x.id === cfg.farm_id); if (a) a.subnet = cfg.subnets.join(','); } }); })
    .catch(() => {});
}

// ── Init ──────────────────────────────────────────────────


// ============================================================
// EKALAVYA — API CONFIG
// Change API_BASE to your Railway backend URL after deployment
// e.g. 'https://ekalavya-backend-production.up.railway.app'
// Leave as localhost for local testing
// ============================================================
function sanitizeUrl(u){
  if(!u||!u.trim())return '';
  u=u.trim().replace(/\/+$/,'');
  if(!u.startsWith('http://') && !u.startsWith('https://')) u='https://'+u;
  return u;
}

// ═══════════════════════════════════════════════════════════
//  FLEET PERSISTENCE — localStorage, dead simple
// ═══════════════════════════════════════════════════════════

function saveFleet() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ w: workers, c: customers, t: Date.now() }));
  } catch(e) {
    console.error('[FLEET] Save error:', e.message);
  }
}

function loadFleet() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) {
      // Try old key migration
      const old = localStorage.getItem('ekl_fleet_v1');
      if (old) {
        const d = JSON.parse(old);
        if (d.workers?.length)   workers   = d.workers;
        if (d.customers?.length) customers = d.customers;
        saveFleet(); // migrate to new key
        console.log('[FLEET] Migrated from old key: ' + workers.length + ' workers');
      }
      return;
    }
    const d = JSON.parse(raw);
    if (d.w?.length)   workers   = d.w;
    if (d.c?.length)   customers = d.c;
    console.log('[FLEET] Loaded: ' + workers.length + ' workers, ' + customers.length + ' customers');
  } catch(e) {
    console.error('[FLEET] Load error:', e.message);
  }
}

// Save to backend (fire and forget — never block UI on this)
function saveFleetToBackend() {
  try {
    const token = localStorage.getItem('ekl_token');
    if (!token) return;
    const base = (typeof API_BASE !== 'undefined') ? API_BASE : '';
    if (!base || base.includes('localhost')) return;
    fetch(base + '/api/fleet/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ workers, customers }),
    }).catch(() => {});
  } catch(e) {}
}

// Load from backend — ADDITIVE ONLY, never removes local data
function loadFleetFromBackend(cb) {
  try {
    const token = localStorage.getItem('ekl_token');
    const base  = (typeof API_BASE !== 'undefined') ? API_BASE : '';
    if (!token || !base || base.includes('localhost')) { if (cb) cb(); return; }
    fetch(base + '/api/fleet/load', { headers: { 'Authorization': 'Bearer ' + token } })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.ok && d.workers?.length > 0) {
          let added = 0;
          d.workers.forEach(bw => {
            if (!workers.find(lw => lw.ip === bw.ip)) { workers.push(bw); added++; }
          });
          (d.customers || []).forEach(bc => {
            if (!customers.find(lc => lc.id === bc.id)) customers.push(bc);
          });
          if (added > 0) { saveFleet(); console.log('[FLEET] +' + added + ' from backend'); }
        }
        loadAgentConfigsFromBackend();
        if (cb) cb();
      })
      .catch(() => { if (cb) cb(); });
  } catch(e) { if (cb) cb(); }
}

function loadAgentConfigsFromBackend(){
  const token=localStorage.getItem('ekl_token');
  if(!token||!API_BASE||API_BASE.includes('localhost')) return;
  fetch(API_BASE+'/api/fleet/agent-configs',{headers:{'Authorization':'Bearer '+token}})
  .then(r=>r.ok?r.json():null)
  .then(d=>{
    if(!d?.configs) return;
    // Merge into localStorage
    d.configs.forEach(cfg=>{
      if(cfg.subnets?.length>0){
        localStorage.setItem('agent_subnets_'+cfg.farm_id, JSON.stringify(cfg.subnets));
        // Update in-memory agent
        const a=agents.find(x=>x.id===cfg.farm_id);
        if(a) a.subnet=cfg.subnets.join(',');
      }
    });
  }).catch(()=>{});
}

// customers managed in persistence layer above


const pools=[
  {flag:'🇺🇸',name:'Foundry USA',coins:['BTC'],fee:'0%',hr:'~140 EH/s',luck:'99.2%',lat:'8ms',s:'online'},
  {flag:'🇨🇳',name:'Antpool',coins:['BTC','LTC'],fee:'0-2.5%',hr:'~95 EH/s',luck:'101%',lat:'12ms',s:'online'},
  {flag:'🇨🇳',name:'F2Pool',coins:['BTC','ETH','LTC'],fee:'2-3%',hr:'~58 EH/s',luck:'98.5%',lat:'15ms',s:'online'},
  {flag:'🇺🇸',name:'Luxor',coins:['BTC','KAS'],fee:'0.3%',hr:'~18 EH/s',luck:'100.2%',lat:'10ms',s:'online'},
  {flag:'🇰🇿',name:'K1Pool',coins:['BTC','KAS'],fee:'0.9%',hr:'~2 EH/s',luck:'98.3%',lat:'35ms',s:'online'},
  {flag:'🇺🇸',name:'Litecoinpool',coins:['LTC','DOGE'],fee:'0%',hr:'~850 TH/s',luck:'100.5%',lat:'11ms',s:'online'},
  {flag:'🇩🇪',name:'Ethermine',coins:['ETH'],fee:'1%',hr:'~12 EH/s',luck:'99.0%',lat:'17ms',s:'online'},
  {flag:'🌍',name:'NiceHash',coins:['BTC'],fee:'2%',hr:'~15 EH/s',luck:'N/A',lat:'20ms',s:'online'},
];

const profitModels=[
  {model:'Antminer S21',hr:200,power:3500,algo:'SHA-256'},
  {model:'Antminer S19 XP',hr:140,power:3010,algo:'SHA-256'},
  {model:'Antminer S19 Pro',hr:110,power:3250,algo:'SHA-256'},
  {model:'Whatsminer M50',hr:126,power:3276,algo:'SHA-256'},
  {model:'Antminer KA3',hr:166000,power:3154,algo:'KHeavyHash'},
  {model:'Antminer L7',hr:9050,power:3425,algo:'Scrypt'},
];

const teamData=[{name:'Alex T.',col:'#e74c3c',role:'Admin',email:'alex@ekalavya.io',last:'2 min ago'},{name:'Sam Lee',col:'#3498db',role:'Manager',email:'sam@ekalavya.io',last:'1h ago'},{name:'Jamie R.',col:'#2ecc71',role:'Technician',email:'jamie@ekalavya.io',last:'3h ago'}];

// LOGIN
function setLTab(t,el){loginTab=t;document.querySelectorAll('.ltab').forEach(x=>x.classList.remove('active'));el.classList.add('active');const b=document.getElementById('lBtn'),h=document.getElementById('lHint');if(t==='customer'){b.className='login-btn customer';b.textContent='ENTER CUSTOMER PORTAL';h.textContent='Demo: ahmad@example.com / ahmad123';}else{b.className='login-btn admin';b.textContent='ACCESS PLATFORM';h.innerHTML='Admin: admin / admin123<br>Customer: ahmad@example.com / ahmad123';}}
function doLogin(){
  const u=document.getElementById('lUser').value.trim();
  const p=document.getElementById('lPass').value;
  const e=document.getElementById('lerr');
  e.style.display='none';
  if(!u||!p){e.textContent='Enter credentials';e.style.display='block';return;}

  if(loginTab==='customer'){
    const c=customers.find(x=>x.email.toLowerCase()===u.toLowerCase());
    if(!c){e.textContent='Customer not found. Contact your administrator.';e.style.display='block';return;}
    isCustomer=true;
    currentUser={...c,role:'customer'};
  } else {
    isCustomer=false;
    currentUser={id:'admin-1',name:u==='admin'?'Admin User':u,role:loginTab==='team'?'technician':'admin'};
  }

  // Get JWT token from backend (non-blocking)
  fetch(API_BASE+'/api/auth/login',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({username:u,password:p})
  }).then(r=>r.json()).then(d=>{
    if(d.token) localStorage.setItem('ekl_token',d.token);
  }).catch(()=>{});

  launchApp();
}
function launchApp(){['loginScreen'].forEach(id=>document.getElementById(id).style.display='none');['ticker','topbar','appBody','bottomNav'].forEach(id=>document.getElementById(id).style.display=id==='appBody'?'flex':id==='bottomNav'?'block':'flex');const ini=currentUser.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();document.getElementById('sideAv').textContent=ini;document.getElementById('sideName').textContent=currentUser.name;document.getElementById('sideRole').textContent=isCustomer?'Customer Portal':currentUser.role==='admin'?'Super Admin':'Team Member';document.getElementById('topBadge').textContent=isCustomer?'PORTAL':'ADMIN';if(isCustomer){document.getElementById('adminNav').style.display='none';document.getElementById('custNav').style.display='block';document.getElementById('agentPill').style.display='none';document.getElementById('bnavAdmin').style.display='none';document.getElementById('bnavCust').style.display='flex';showPage('portal-home');document.getElementById('custNav').querySelector('.nav-item').classList.add('active');renderPortal();}else{populateDropdowns();renderAll();}initTicker();// updateTicker removed — was demo data onlysetInterval(liveUpdate,30000);fetchAgents();setInterval(fetchAgents,30000);
  // WebSocket for real-time scan results
  try {
    const wsUrl = API_BASE.replace('https://','wss://').replace('http://','ws://') + '/ws';
    const liveWs = new WebSocket(wsUrl);
    liveWs.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if(msg.type==='scan_found' && msg.miner){
          scanFound++;
          _lastScanResults[msg.miner.ip] = {...msg.miner, _farmId: currentScanFarmId, _farmName: currentScanFarmName};
          document.getElementById('foundCount').textContent=scanFound;
          addLog('found','[ FOUND ] '+msg.miner.ip+' — '+(msg.miner.brand||'')+' '+(msg.miner.model||'ASIC')+' | '+msg.miner.hr_display+' | '+(msg.miner.temp||'—')+'°C');
          addFoundCard(msg.miner);
          document.getElementById('foundSection').style.display='block';
          document.getElementById('discCount').textContent=scanFound+' Found';
        }
        if(msg.type==='scan_progress'){
          const pct=msg.progress||0;
          document.getElementById('progFill').style.width=pct+'%';
          document.getElementById('scanStatus').textContent=pct+'%';
          document.getElementById('scanCount').textContent=msg.scanned||0;
          if(msg.done) stopScan();
        }
        if(msg.type==='agent_connected') fetchAgents();
        if(msg.type==='agent_disconnected') fetchAgents();
      } catch(e) {}
    };
    liveWs.onerror = () => {};
  } catch(e) {}if('serviceWorker'in navigator)navigator.serviceWorker.register('sw.js').catch(()=>{});
  try { checkApiSetup(); } catch(e){}
  try { loadFleet(); } catch(e){}
  try { initSensors(); } catch(e){}
  try { renderAll(); } catch(e){ console.error('renderAll error:',e); }
  window.addEventListener('beforeunload', function(){ try{saveFleet();}catch(e){} });

  // Fetch agents immediately, then re-render so workers match their farms
  try { fetchAgents(); } catch(e){}
  setTimeout(function(){ try{ fetchAgents(); }catch(e){} }, 2000);
  setInterval(function(){ try{ fetchAgents(); }catch(e){} }, 30000);

  setTimeout(function(){
    try{ loadFleetFromBackend(function(){ try{ renderAll(); }catch(e){} }); }catch(e){}
  }, 2500);
  setInterval(function(){ try{saveFleet();}catch(e){}}, 30000);
  const d=document.getElementById('currentApiDisplay');if(d)d.textContent=API_BASE;
  const ai=document.getElementById('apiUrl');if(ai)ai.value=API_BASE;}
function logout(){location.reload();}

// NAV
function showPage(n){document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));const pg=document.getElementById('page-'+n);if(pg)pg.classList.add('active');if(n==='scada')checkScadaSession();
  if(n==='settings'){updateFleetStat();renderSensorEntryGrid();}}
function nav(page,el){showPage(page);document.querySelectorAll('.nav-item').forEach(x=>x.classList.remove('active'));if(el)el.classList.add('active');}

// TICKER
function initTicker(){let h='';Object.entries(coins).forEach(([k,d])=>{const dir=d.c>=0?'up':'dn',s=d.c>=0?'+':'';h+=`<div class="tick-item"><span class="t-sym" style="color:${d.col}">${d.ico} ${k}</span><span class="t-price">$${d.p.toLocaleString()}</span><span class="t-chg ${dir}">${s}${d.c}%</span></div>`;});document.getElementById('tickTrack').innerHTML=h+h;}
function updateTicker(){Object.keys(coins).forEach(k=>{coins[k].p=parseFloat((coins[k].p*(1+(Math.random()-.5)*.003)).toFixed(k==='BTC'||k==='ETH'?2:4));coins[k].c=parseFloat((coins[k].c+(Math.random()-.5)*.4).toFixed(2));});initTicker();}

// HELPERS
function sdot(w){return w.disabled||w.status==='disabled'?'dis':w.status==='sleeping'?'slp':w.status==='rebooting'?'rb':w.status==='online'?'on':w.status==='warn'?'wn':'off';}
function sbadge(w){const m={online:'bgn',warn:'bwn',offline:'brn',disabled:'bor',sleeping:'bpp',rebooting:'bc'};const l={online:'ONLINE',warn:'WARNING',offline:'OFFLINE',disabled:'DISABLED',sleeping:'SLEEPING',rebooting:'REBOOTING'};return `<span class="badge ${m[w.status]||'bc'}">${l[w.status]||w.status.toUpperCase()}</span>`;}
function getAlgoFromModel(model){
  const m=(model||'').toLowerCase();
  // Scrypt — LTC miners: L3, L3+, L5, L7, L9, L11, L15, L19
  // Match: "l3", "l3+", "l5", "l7", "l9", "l11", "l15", "l19", "antminer l", etc.
  if(/\bl[0-9]+/.test(m)||m.includes('scrypt')||m.includes('litecoin')||m.includes('ltc')||m.includes(' l3')||m.includes(' l5')||m.includes(' l7')||m.includes(' l9')) return 'Scrypt';
  // KHeavyHash — KAS miners
  if(m.includes('ka3')||m.includes('kaspa')||m.includes('kheavy')||m.includes('ika')) return 'KHeavyHash';
  // X11 — DASH miners
  if(m.includes('d9')||m.includes('d19')||m.includes('dash')||m.includes('x11')) return 'X11';
  // Blake2B — Handshake, Sia
  if(m.includes('hs')||m.includes('blake')||m.includes('handshake')) return 'Blake2B';
  // Ethash
  if(m.includes('e9')||m.includes('ethash')) return 'Ethash';
  return 'SHA-256';
}
function hrDisplay(w){
  if(!w.hashrate||w.hashrate===0) return '<span style="color:var(--mute)">—</span>';
  // Use agent-provided display string if available and meaningful
  if(w.hr_display && w.hr_display!=='—' && w.hr_display!=='0.00 TH/s' && w.hr_display!=='0.00 GH/s') return w.hr_display;
  // Determine unit from stored value or model detection
  const algo    = w.algo || getAlgoFromModel(w.model||'');
  const ghAlgos = ['Scrypt','KHeavyHash','X11','Blake2B','Ethash','Equihash'];
  const isGH    = w.hr_unit==='GH/s' || ghAlgos.includes(algo);
  const unit    = isGH ? 'GH/s' : 'TH/s';
  const val     = w.hashrate;
  // Auto-scale: if SHA-256 miner shows tiny TH value, might be stored as MH
  if(!isGH && val < 0.1 && val > 0) return (val*1000).toFixed(1)+' GH/s'; // convert TH→GH for display
  return val.toFixed(2)+' '+unit;
}
function toast(msg,col){const t=document.createElement('div');t.className='toast';t.style.borderColor=col||'var(--b1)';t.textContent=msg;document.body.appendChild(t);setTimeout(()=>t.remove(),5000);}


// ── Missing stubs ─────────────────────────────────────────
function renderTeam() {
  const el = document.getElementById('page-team');
  if (el) el.innerHTML = '<div style="padding:30px;color:var(--mute);text-align:center">Team management coming soon.</div>';
}

function checkScadaSession() {
  if (!scadaToken) return;
  fetch(API_BASE + '/api/scada/overview', {headers: {'x-scada-token': scadaToken}})
    .then(function(r) {
      if (r.status === 401) { scadaToken = null; localStorage.removeItem('scada_token'); }
      else showScadaDashboard();
    }).catch(function() { showScadaDashboard(); });
}

function openManualEntry(preselect) {
  var sel = document.getElementById('manualCabSel');
  if (sel && preselect) sel.value = preselect;
  openSheet('manualEntrySheet');
}

function saveManualReading() {
  var id = document.getElementById('manualCabSel')?.value;
  if (!id) return;
  var data = {
    power_kw:     document.getElementById('m_power')?.value,
    voltage_v:    document.getElementById('m_voltage')?.value,
    current_a:    document.getElementById('m_current')?.value,
    frequency_hz: document.getElementById('m_freq')?.value,
    temp_c:       document.getElementById('m_temp')?.value,
    rpm:          document.getElementById('m_rpm')?.value,
    flow_rate:    document.getElementById('m_flow')?.value,
    water_level:  document.getElementById('m_level')?.value,
    notes:        document.getElementById('m_notes')?.value
  };
  fetch(API_BASE + '/api/scada/cabinets/' + id + '/manual', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'x-scada-token': scadaToken},
    body: JSON.stringify(data)
  }).then(function(r) { return r.json(); }).then(function(d) {
    if (d.ok) { closeSheet('manualEntrySheet'); scadaRefresh(); toast('✓ Reading saved', 'var(--green)'); }
  }).catch(function(e) { toast('Error: ' + e.message, 'var(--red)'); });
}

function renderAll(){try{renderDash();}catch(e){} try{updateNavCount();}catch(e){}}

// Fetch real agents from backend API
function fetchAgents(){
  const url = API_BASE + '/api/agents';
  fetch(url)
    .then(r => { if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
    .then(d => {
      if(d.agents !== undefined){
        agents = d.agents.map(a => ({
          id:       a.farm_id,
          name:     a.farm_name,
          subnet:   a.subnet,
          host:     a.hostname      || 'unknown',
          ver:      a.agent_version || '1.0.0',
          online:   a.online !== false,
          count:    a.miner_count   || 0,
          lastSeen: a.last_seen_ago || 'Just now',
          lastPoll: a.last_seen_ago || 'Just now',
        }));
        updateAgentUI();
      }
    })
    .catch(err => console.warn('[EKL] fetchAgents failed:', err.message));
}

function updateAgentUI(){
  const ca = agents.filter(a => a.online).length;

  // Update topbar pill
  const pill  = document.getElementById('agentPillTxt');
  const badge = document.getElementById('agentNavBadge');
  const sbadge= document.getElementById('agentStripBadge');
  const cbadge= document.getElementById('agentCountBadge');
  if(pill)   pill.textContent   = ca+' Agent'+(ca!==1?'s':'');
  if(badge)  badge.textContent  = ca;
  if(sbadge) sbadge.textContent = ca+' Online';
  if(cbadge) cbadge.textContent = ca+' Online';

  // Update stat card on dashboard
  const dAgents = document.getElementById('dAgents');
  if(dAgents) dAgents.textContent = ca;

  // Update agent strip on dashboard
  const strip = document.getElementById('agentStrip');
  if(strip){
    strip.innerHTML = agents.length === 0
      ? '<div style="padding:20px;text-align:center;color:var(--mute);font-size:12px">No agents connected. Run SETUP-WINDOWS.bat on each farm PC.</div>'
      : agents.map(a => `
        <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--b1)">
          <span class="sdot ${a.online?'on':'off'}"></span>
          <div style="flex:1">
            <div style="font-family:'Exo 2',sans-serif;font-weight:700;font-size:13px;color:var(--txt)">${a.name}</div>
            <div style="font-size:10px;color:var(--mute)">${a.subnet} &nbsp;·&nbsp; ${a.count} miners &nbsp;·&nbsp; ${a.lastSeen}</div>
          </div>
          <span class="badge ${a.online?'bgn':'brn'}">${a.online?'ONLINE':'OFFLINE'}</span>
          <button class="abtn" onclick="triggerScan('${a.id}')">Scan</button>
        </div>`).join('');
  }

  // Update Farm Agents page grid
  const grid = document.getElementById('agentGrid');
  if(grid){
    grid.innerHTML = agents.length === 0
      ? '<div style="padding:30px;text-align:center;color:var(--mute)">No agents connected yet.<br>Run SETUP-WINDOWS.bat on each farm PC.</div>'
      : agents.map(a => `
        <div class="card">
          <div class="card-head">
            <span style="font-size:22px">${a.name.includes('Dubai')||a.name.includes('dubai')?'🇦🇪':a.name.includes('KZ')||a.name.includes('Kazakhstan')?'🇰🇿':a.name.includes('USA')||a.name.includes('Texas')?'🇺🇸':'🏭'}</span>
            <div style="flex:1">
              <div style="font-family:'Exo 2',sans-serif;font-weight:700;font-size:14px;color:var(--txt)">${a.name}</div>
              <div style="font-size:10px;color:var(--mute)">${a.host} &nbsp;·&nbsp; v${a.ver}</div>
            </div>
            <span class="badge ${a.online?'bgn':'brn'}">${a.online?'ONLINE':'OFFLINE'}</span>
          </div>
          <div style="padding:4px 14px 0"><div class="tline ${a.online?'':'off'}"></div></div>
          <div class="card-body">
            <div class="card-row"><span class="ck">Subnet</span><span class="cv">${a.subnet}</span></div>
            <div class="card-row"><span class="ck">Miners Found</span><span class="cv g">${a.count}</span></div>
            <div class="card-row"><span class="ck">Last Seen</span><span class="cv ${a.online?'g':'r'}">${a.lastSeen}</span></div>
            <div class="card-row"><span class="ck">Version</span><span class="cv">v${a.ver}</span></div>
          </div>
          <div class="card-foot">
            <button class="btn btn-sm ${!a.online?'btn-r':''}" onclick="triggerScan('${a.id}')">${a.online?'📡 Scan Network':'✗ Offline'}</button>
            <button class="btn btn-sm" onclick="alert('Syncing ${a.name}...')">↺ Sync</button>
          </div>
        </div>`).join('');
  }

  // Update scanner dropdown
  populateDropdowns();
  // Re-render fleet view
  if(document.getElementById('fleetByFarm')) renderFleetByFarm();
}

// DASHBOARD
function drawPie(online, offline, disabled_) {
  const total = online + offline + disabled_;
  if (total === 0) return;
  const svg = document.getElementById('fleetPie');
  const leg = document.getElementById('pieLegend');
  if (!svg || !leg) return;

  const cx = 60, cy = 60, r = 48, inner = 30;
  const data = [
    { v: online,    color: 'var(--green)',  label: 'Online'   },
    { v: offline,   color: 'var(--red)',    label: 'Offline'  },
    { v: disabled_, color: 'var(--orange)', label: 'Disabled' },
  ].filter(d => d.v > 0);

  let paths = '', startAngle = -Math.PI / 2;
  data.forEach(seg => {
    const angle = (seg.v / total) * 2 * Math.PI;
    const end   = startAngle + angle;
    const x1o = cx + r     * Math.cos(startAngle), y1o = cy + r     * Math.sin(startAngle);
    const x2o = cx + r     * Math.cos(end),         y2o = cy + r     * Math.sin(end);
    const x1i = cx + inner * Math.cos(end),         y1i = cy + inner * Math.sin(end);
    const x2i = cx + inner * Math.cos(startAngle),  y2i = cy + inner * Math.sin(startAngle);
    const large = angle > Math.PI ? 1 : 0;
    paths += `<path d="M${x1o.toFixed(1)},${y1o.toFixed(1)} A${r},${r} 0 ${large},1 ${x2o.toFixed(1)},${y2o.toFixed(1)} L${x1i.toFixed(1)},${y1i.toFixed(1)} A${inner},${inner} 0 ${large},0 ${x2i.toFixed(1)},${y2i.toFixed(1)} Z" fill="${seg.color}" opacity="0.85"/>`;
    startAngle = end;
  });

  // Center text
  paths += `<text x="60" y="57" text-anchor="middle" font-size="18" font-family="Share Tech Mono" fill="var(--cyan)">${total}</text>`;
  paths += `<text x="60" y="70" text-anchor="middle" font-size="8" font-family="Exo 2" fill="var(--mute)">MINERS</text>`;
  svg.innerHTML = paths;

  leg.innerHTML = data.map(d =>
    `<div style="display:flex;justify-content:space-between;padding:2px 0">
      <span style="color:${d.color}">● ${d.label}</span>
      <span style="font-family:'Share Tech Mono',monospace;color:var(--txt)">${d.v}</span>
    </div>`
  ).join('');
}

function renderDash(){
  const online   = workers.filter(w=>w.status==='online');
  const offline  = workers.filter(w=>w.status==='offline');
  const disabled = workers.filter(w=>w.disabled||w.status==='disabled');
  const warning  = workers.filter(w=>w.status==='warn');

  // Total hashrate — mix of TH and GH, convert all to TH for display
  const totalTH = online.reduce((a,w)=>{
    if(!w.hashrate) return a;
    const unit = w.hr_unit || 'TH/s';
    return a + (unit==='GH/s' ? w.hashrate/1000 : w.hashrate);
  }, 0);

  const ca = agents.filter(a=>a.online).length;
  const uniqueModels = [...new Set(workers.map(w=>w.model).filter(Boolean))].length;

  document.getElementById('dHR').textContent     = totalTH >= 1 ? totalTH.toFixed(1) : (totalTH*1000).toFixed(0);
  document.getElementById('dHRUnit').textContent  = totalTH >= 1 ? 'TH/s' : 'GH/s';
  document.getElementById('dW').textContent       = online.length;
  document.getElementById('dWTotal').textContent  = workers.length;
  document.getElementById('dAgents').textContent  = ca;
  document.getElementById('dDis').textContent     = disabled.length;
  document.getElementById('dModels').textContent  = uniqueModels;

  // Badges
  const pill  = document.getElementById('agentPillTxt');
  const badge = document.getElementById('agentNavBadge');
  const sstrip= document.getElementById('agentStripBadge');
  if(pill)  pill.textContent  = ca+' Agent'+(ca!==1?'s':'');
  if(badge) badge.textContent = ca;
  if(sstrip)sstrip.textContent= ca+' Online';
  document.getElementById('dOnlineBadge').textContent  = online.length+' Online';
  document.getElementById('dOfflineBadge').textContent = offline.length+' Offline';
  const db=document.getElementById('dDisBadge');
  if(db){if(disabled.length){db.textContent=disabled.length+' Disabled';db.style.display='';}else db.style.display='none';}

  // Pie chart
  drawPie(online.length, offline.length + warning.length, disabled.length);

  // Farm cards — group workers by farm_id
  const farmMap = {};
  // Start from agents (source of truth)
  agents.forEach(a => {
    farmMap[a.id] = { id:a.id, name:a.name, workers:[], agent:a };
  });
  // Assign workers to correct farms
  workers.forEach(w => {
    const fid = w.farm_id || 'unknown';
    if(farmMap[fid]){
      farmMap[fid].workers.push(w);
    } else if(agents.length===1){
      w.farm_id=agents[0].id; w.farm=agents[0].name;
      farmMap[agents[0].id].workers.push(w);
    } else {
      const orphanName = w.farm || fid;
      if(!farmMap[fid]) farmMap[fid]={id:fid, name:orphanName, workers:[], agent:null};
      farmMap[fid].workers.push(w);
    }
  });

  const fc = document.getElementById('farmCards');
  if (fc) {
    fc.innerHTML = Object.values(farmMap).map(farm => {
      const fOnline   = farm.workers.filter(w=>w.status==='online').length;
      const fTotal    = farm.workers.length;
      const fModels   = [...new Set(farm.workers.map(w=>w.model).filter(Boolean))];
      const fHR       = farm.workers.filter(w=>w.status==='online').reduce((a,w)=>{
        const unit = w.hr_unit||'TH/s';
        return a+(unit==='GH/s'?w.hashrate/1000:w.hashrate||0);
      },0);
      const agOnline  = farm.agent?.online;
      return `<div style="background:var(--s2);border:1px solid var(--b${agOnline?'2':'1'});border-radius:8px;padding:10px;cursor:pointer" onclick="filterByFarm('${farm.id}')">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
          <span class="sdot ${agOnline?'on':'off'}"></span>
          <span style="font-family:'Exo 2',sans-serif;font-weight:700;font-size:12px;color:var(--txt)">${farm.name}</span>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:10px">
          <div><div style="color:var(--mute)">Online</div><div style="font-family:'Share Tech Mono',monospace;color:var(--green)">${fOnline}/${fTotal}</div></div>
          <div><div style="color:var(--mute)">Hashrate</div><div style="font-family:'Share Tech Mono',monospace;color:var(--cyan)">${fHR>=1?fHR.toFixed(1):'<1'} TH</div></div>
        </div>
        <div style="margin-top:6px;font-size:9px;color:var(--mute)">${fModels.slice(0,2).join(', ')+(fModels.length>2?' +'+( fModels.length-2)+' more':'')}</div>
      </div>`;
    }).join('');
  }

  // Agent strip
  const strip = document.getElementById('agentStrip');
  if(strip){
    strip.innerHTML = agents.length === 0
      ? '<div style="padding:20px;text-align:center;color:var(--mute);font-size:12px">No agents connected. Run SETUP-WINDOWS.bat on farm PC.</div>'
      : agents.map(a=>`<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--b1)">
          <span class="sdot ${a.online?'on':'off'}"></span>
          <div style="flex:1">
            <div style="font-family:'Exo 2',sans-serif;font-weight:700;font-size:13px">${a.name}</div>
            <div style="font-size:10px;color:var(--mute)">${a.subnet} · ${a.count} miners · ${a.lastSeen}</div>
          </div>
          <span class="badge ${a.online?'bgn':'brn'}">${a.online?'ONLINE':'OFFLINE'}</span>
          <button class="abtn" onclick="triggerScan('${a.id}')">📡 Scan</button>
        </div>`).join('');
  }

  // Fleet by farm
  renderFleetByFarm();
  if(false){ // disabled — old workers table
  document.getElementById('dashTbody_disabled').innerHTML = workers.map(w=>{
    const c  = customers.find(x=>x.id===w.cid);
    const tc = w.temp>=90?'style="color:var(--red)"':w.temp>=82?'style="color:var(--warn)"':'';
    return `<tr style="${w.disabled?'opacity:.55':''}">
      <td><div style="display:flex;align-items:center;gap:6px"><span class="sdot ${sdot(w)}"></span><span style="font-family:'Exo 2',sans-serif;font-weight:600">${w.name}</span></div></td>
      <td><div style="font-size:11px;font-family:'Exo 2',sans-serif">${w.brand||''} ${w.model}</div><div style="font-size:9px;color:var(--mute)">${w.algo||'SHA-256'}</div></td>
      <td style="font-size:11px">${w.ip}</td>
      <td style="font-size:11px">${w.farm||'—'}</td>
      <td>${c?`<span style="color:var(--cyan);font-size:11px">${c.name}</span>`:'<span style="color:var(--mute)">—</span>'}</td>
      <td style="color:var(--green)">${hrDisplay(w)}</td>
      <td ${tc}>${w.temp>0?w.temp+'°C':'—'}</td>
      <td style="font-size:10px;color:var(--mute)">${w.pool}</td>
      <td>${sbadge(w)}</td>
      <td><button class="abtn" onclick="openCtrl('${w.id}')" style="border-color:var(--cyan);color:var(--cyan);font-weight:700">⚙ Control</button></td>
    </tr>`;
  }).join('');
  } // end disabled
}

function renderFleetByFarm(){
  const el = document.getElementById('fleetByFarm');
  if(!el) return;
  const hash = workers.length+'|'+agents.map(a=>a.id+(a.online?'1':'0')).join('|');
  if(hash === _fleetHash) return;
  _fleetHash = hash;

  if(workers.length===0 && agents.length===0){
    el.innerHTML='<div style="text-align:center;padding:30px;color:var(--mute)">No miners yet. Use Network Scanner to discover miners.</div>';
    return;
  }

  const farmMap={};
  // Start from connected agents
  agents.forEach(function(a){ farmMap[a.id]={id:a.id,name:a.name,workers:[],agent:a}; });
  // Place each worker — create a farm entry from the worker's own stored farm name
  // if the agent isn't connected/loaded yet (prevents everything showing as Unassigned)
  workers.forEach(function(w){
    const fid = w.farm_id || 'unknown';
    if(!farmMap[fid]){
      farmMap[fid] = {
        id:   fid,
        name: w.farm || fid,
        workers: [],
        agent: agents.find(function(a){ return a.id === fid; }) || null
      };
    }
    farmMap[fid].workers.push(w);
  });

  let html = '';
  Object.values(farmMap).forEach(function(farm){
    const online  = farm.workers.filter(function(w){return w.status==='online';}).length;
    const offline = farm.workers.filter(function(w){return w.status==='offline'||w.status==='warn';}).length;
    const repair  = farm.workers.filter(function(w){return w.disabled||w.status==='disabled';}).length;
    const ag      = farm.agent;
    const onl     = ag && ag.online;
    html += '<div class="farm-card-click" data-fid="'+farm.id+'" style="background:var(--s2);border:1px solid var(--b1);border-radius:8px;padding:12px;margin-bottom:8px;cursor:pointer">';
    html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">';
    html += '<span class="sdot '+(onl?'on':'off')+'"></span>';
    html += '<span style="font-family:Orbitron,sans-serif;font-size:13px;font-weight:700;color:var(--txt)">'+farm.name+'</span>';
    html += '<span class="badge '+(onl?'bgn':'brn')+'" style="margin-left:auto">'+(onl?'ONLINE':'OFFLINE')+'</span>';
    html += '</div><div style="display:flex;gap:10px;flex-wrap:wrap">';
    html += '<div style="background:rgba(0,255,157,.06);border:1px solid rgba(0,255,157,.2);border-radius:5px;padding:6px 12px;text-align:center"><div style="font-size:9px;color:var(--mute)">Online</div><div style="font-family:Share Tech Mono,monospace;font-size:20px;color:var(--green)">'+online+'</div></div>';
    html += '<div style="background:rgba(255,45,85,.06);border:1px solid rgba(255,45,85,.2);border-radius:5px;padding:6px 12px;text-align:center"><div style="font-size:9px;color:var(--mute)">Offline</div><div style="font-family:Share Tech Mono,monospace;font-size:20px;color:var(--red)">'+offline+'</div></div>';
    if(repair) html += '<div style="background:rgba(255,107,53,.06);border:1px solid rgba(255,107,53,.2);border-radius:5px;padding:6px 12px;text-align:center"><div style="font-size:9px;color:var(--mute)">Repair</div><div style="font-family:Share Tech Mono,monospace;font-size:20px;color:var(--orange)">'+repair+'</div></div>';
    html += '<div style="background:rgba(0,200,255,.06);border:1px solid rgba(0,200,255,.2);border-radius:5px;padding:6px 12px;text-align:center"><div style="font-size:9px;color:var(--mute)">Total</div><div style="font-family:Share Tech Mono,monospace;font-size:20px;color:var(--cyan)">'+farm.workers.length+'</div></div>';
    html += '</div></div>';
  });
  el.innerHTML = html;
  // Attach click handlers via event delegation (no inline onclick needed)
  el.querySelectorAll('.farm-card-click').forEach(function(card){
    card.addEventListener('click', function(){ openFarmDetail(this.dataset.fid); });
  });
}

function openFarmDetail(farmId){
  currentFarmId = farmId;
  const farm = agents.find(a=>a.id===farmId) || {name:farmId, subnet:'—', online:false};
  const farmWorkers = workers.filter(w=>w.farm_id===farmId);
  const online  = farmWorkers.filter(w=>w.status==='online').length;
  const total   = farmWorkers.length;

  document.getElementById('farmDetailName').textContent = farm.name;
  document.getElementById('farmDetailSub').textContent  = `${farm.subnet} · ${online}/${total} online · Agent: ${farm.online?'Connected':'Offline'}`;

  // Miners list
  const mEl = document.getElementById('farmDetailMiners');
  if(farmWorkers.length === 0){
    mEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--mute)">No miners added from this farm yet.<br>Use Network Scanner to discover miners.</div>';
  } else {
    mEl.innerHTML = `<table style="width:100%;border-collapse:collapse;font-family:'Share Tech Mono',monospace;font-size:11px">
      <thead><tr style="background:var(--s2)">
        <th style="padding:7px 10px;text-align:left;color:var(--mute);font-size:9px;letter-spacing:1px">STATUS</th>
        <th style="padding:7px 10px;text-align:left;color:var(--mute);font-size:9px;letter-spacing:1px">MACHINE</th>
        <th style="padding:7px 10px;text-align:left;color:var(--mute);font-size:9px;letter-spacing:1px">MODEL</th>
        <th style="padding:7px 10px;text-align:left;color:var(--mute);font-size:9px;letter-spacing:1px">HASHRATE</th>
        <th style="padding:7px 10px;text-align:left;color:var(--mute);font-size:9px;letter-spacing:1px">TEMP</th>
        <th style="padding:7px 10px;text-align:left;color:var(--mute);font-size:9px;letter-spacing:1px">POOL</th>
      </tr></thead>
      <tbody>${farmWorkers.map(w=>{
        const tc=w.temp>=90?'color:var(--red)':w.temp>=80?'color:var(--warn)':'';
        return `<tr style="border-bottom:1px solid rgba(26,42,58,.4)">
          <td style="padding:7px 10px"><span class="sdot ${sdot(w)}"></span></td>
          <td style="padding:7px 10px"><div style="font-family:'Exo 2',sans-serif;font-weight:600">${w.name}</div><div style="font-size:9px;color:var(--mute)">${w.ip}</div></td>
          <td style="padding:7px 10px;color:var(--mute)">${w.brand||''} ${w.model}</td>
          <td style="padding:7px 10px;color:var(--green)">${hrDisplay(w)}</td>
          <td style="padding:7px 10px;${tc}">${w.temp>0?w.temp+'°C':'—'}</td>
          <td style="padding:7px 10px;font-size:10px;color:var(--mute)">${w.pool||'—'}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
  }

  // Fetch sensor readings for this farm
  loadFarmSensors(farmId);

  document.getElementById('farmDetailOverlay').classList.add('show');
}

function closeFarmDetail(){
  document.getElementById('farmDetailOverlay').classList.remove('show');
  currentFarmId = null;
  clearInterval(_sensorPollInt);
  _sensorPollInt = null;
}


function loadFarmSensors(farmId){
  const el = document.getElementById('farmSensors');
  if(!el) return;

  // Clear old auto-refresh
  clearInterval(_sensorPollInt);

  // Show local reading instantly
  const local = getSensorReading(farmId);
  if(local) renderSensorInPanel(farmId, local);
  else renderSensorInPanel(farmId, null);

  // Fetch from backend (agent pushes live data here)
  fetchSensorFromBackend(farmId);

  // No auto-refresh interval — user can tap ↺ Refresh manually
}

function fetchSensorFromBackend(farmId){
  if(!farmId || farmId==='null' || farmId==='undefined') return;
  const token = localStorage.getItem('ekl_token');
  if(!token || !API_BASE || API_BASE.includes('localhost')) return;
  fetch(API_BASE+'/api/sensors/farm/'+farmId, {headers:{'Authorization':'Bearer '+token}})
  .then(r=>r.ok?r.json():null)
  .then(d=>{
    if(d?.sensors?.length>0){
      const s=d.sensors[0];
      setSensorReading(farmId, s);
      renderSensorInPanel(farmId, s);
      const ts=document.getElementById('sensorLastUpdate');
      if(ts) ts.textContent='Updated '+new Date().toLocaleTimeString();
    }
  }).catch(()=>{});
}

function refreshFarmSensor(){
  if(currentFarmId) fetchSensorFromBackend(currentFarmId);
}

function renderSensorInPanel(farmId, r){
  const el=document.getElementById('farmSensors');
  if(!el) return;
  if(!r || (r.temp==null && r.humidity==null)){
    el.innerHTML=`<div style="background:var(--s2);border:1px solid var(--b1);border-radius:8px;padding:20px;text-align:center;color:var(--mute)">
      <div style="font-size:24px;margin-bottom:8px">🌡</div>
      <div style="font-size:11px">No sensor reading yet.</div>
      <div style="font-size:10px;margin-top:6px">Click <strong>Discover</strong> to find Sonoff TH16 sensors on this network.<br>Or enter readings manually in Settings.</div>
    </div>`;
    return;
  }
  const tc=r.temp>=45?'var(--red)':r.temp>=38?'var(--warn)':'var(--green)';
  el.innerHTML=`<div style="background:linear-gradient(135deg,var(--s2),rgba(0,200,255,.04));border:1px solid rgba(0,200,255,.2);border-radius:10px;padding:16px">
    <div style="display:flex;align-items:center;justify-content:center;gap:24px;margin-bottom:10px">
      <div style="text-align:center">
        <div style="font-family:'Share Tech Mono',monospace;font-size:48px;font-weight:700;color:${tc};line-height:1;text-shadow:0 0 20px ${tc}55">${r.temp!=null?r.temp:'—'}</div>
        <div style="font-size:10px;color:var(--mute);text-transform:uppercase;letter-spacing:2px;margin-top:4px">°C Temperature</div>
      </div>
      <div style="width:1px;height:60px;background:var(--b1)"></div>
      <div style="text-align:center">
        <div style="font-family:'Share Tech Mono',monospace;font-size:48px;font-weight:700;color:var(--cyan);line-height:1;text-shadow:0 0 20px rgba(0,200,255,.3)">${r.humidity!=null?r.humidity:'—'}</div>
        <div style="font-size:10px;color:var(--mute);text-transform:uppercase;letter-spacing:2px;margin-top:4px">% Humidity</div>
      </div>
    </div>
    <div style="display:flex;justify-content:center;gap:6px;flex-wrap:wrap">
      ${r.ip?`<span style="font-family:'Share Tech Mono',monospace;font-size:9px;color:var(--mute);background:var(--bg);border:1px solid var(--b1);border-radius:3px;padding:2px 6px">${r.ip}</span>`:''}
      <span style="font-size:9px;color:var(--mute)">${r.updated?new Date(r.updated).toLocaleString():''}</span>
    </div>
  </div>`;
}

function discoverSensors(){
  document.getElementById('sensorDiscoverPanel').style.display='block';
}

function startSensorDiscover(){
  const mac=document.getElementById('sensorMacInput')?.value.trim();
  const ip =document.getElementById('sensorIpInput')?.value.trim();
  if(!mac&&!ip){alert('Enter a MAC address or IP address');return;}
  const status=document.getElementById('sensorDiscoverStatus');
  status.style.color='var(--cyan)';

  const token=localStorage.getItem('ekl_token');
  if(!token){status.textContent='Not logged in';status.style.color='var(--red)';return;}

  let body, msg;
  if(mac){
    // MAC-based (preferred)
    const macs=mac.split(',').map(m=>m.trim()).filter(Boolean);
    body={farm_id:currentFarmId, macs};
    msg=`Resolving MAC ${mac} → finding IP via ARP...`;
  } else {
    // IP range
    const ips=expandIPRange(ip);
    if(ips.length===0){alert('Invalid IP format');return;}
    body={farm_id:currentFarmId, ips};
    msg=`Scanning ${ips.length} IP${ips.length>1?'s':''} for Sonoff sensors...`;
  }

  status.textContent=msg;
  fetch(API_BASE+'/api/sensors/discover',{
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
    body:JSON.stringify(body)
  })
  .then(r=>r.json())
  .then(d=>{
    if(d.ok){
      status.textContent=mac
        ? '✓ Sent to agent — it will resolve the MAC and start reading. Check back in 30s.'
        : '✓ Scanning started — readings appear when sensors are found.';
      status.style.color='var(--green)';
    } else {
      status.textContent='Error: '+d.error;
      status.style.color='var(--red)';
    }
  })
  .catch(e=>{status.textContent='Error: '+e.message;status.style.color='var(--red)';});
}

function expandIPRange(input){
  if(!input) return [];
  try {
    if(input.includes('-')){
      const [start,end]=input.split('-');
      const parts=start.split('.');
      const prefix=parts.slice(0,3).join('.');
      const s=parseInt(parts[3])||1;
      const e=Math.min(parseInt(end)||254, 255);
      return Array.from({length:e-s+1},(_,i)=>`${prefix}.${s+i}`);
    }
    if(input.split('.').length===3) return Array.from({length:254},(_,i)=>`${input}.${i+1}`);
    return [input];
  } catch(e){ return []; }
}

function renderSensorCard(farmId, r){
  const tempColor = r.temp>=45?'var(--red)':r.temp>=38?'var(--warn)':'var(--green)';
  return `<div style="background:var(--s2);border:1px solid var(--b1);border-radius:10px;padding:16px">
    <div style="display:flex;gap:16px;justify-content:center;align-items:center;margin-bottom:8px">
      <div style="text-align:center">
        <div style="font-family:'Share Tech Mono',monospace;font-size:36px;color:${tempColor};line-height:1">${r.temp!=null?r.temp+'°':'—'}</div>
        <div style="font-size:9px;color:var(--mute);text-transform:uppercase;letter-spacing:1px">Temperature</div>
      </div>
      <div style="width:1px;height:50px;background:var(--b1)"></div>
      <div style="text-align:center">
        <div style="font-family:'Share Tech Mono',monospace;font-size:36px;color:var(--cyan);line-height:1">${r.humidity!=null?r.humidity+'%':'—'}</div>
        <div style="font-size:9px;color:var(--mute);text-transform:uppercase;letter-spacing:1px">Humidity</div>
      </div>
    </div>
    <div style="font-size:9px;color:var(--mute);text-align:center">${r.name||farmId} · ${r.updated?new Date(r.updated).toLocaleString():''}</div>
  </div>`;
}

// ── eWeLink config ─────────────────────────────────────────
function saveEwelinkConfig(){
  const cfg = {
    email:    document.getElementById('ewEmail').value.trim(),
    password: document.getElementById('ewPass').value,
    region:   document.getElementById('ewRegion').value,
  };
  if(!cfg.email||!cfg.password){alert('Email and password required');return;}
  document.getElementById('ewStatus').textContent = 'Saving and connecting...';
  fetch(API_BASE+'/api/sensors/config',{
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':'Bearer '+(localStorage.getItem('ekl_token')||'')},
    body:JSON.stringify(cfg)
  })
  .then(r=>r.json())
  .then(()=>{
    return fetch(API_BASE+'/api/sensors/login',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+(localStorage.getItem('ekl_token')||'')},
      body:JSON.stringify({})
    });
  })
  .then(r=>r.json())
  .then(d=>{
    if(d.ok){
      document.getElementById('ewStatus').innerHTML = '<span style="color:var(--green)">✓ Connected — '+d.devices+' devices found</span>';
      fetchEwelinkDevices();
    } else {
      document.getElementById('ewStatus').innerHTML = '<span style="color:var(--red)">✗ '+d.error+'</span>';
    }
  })
  .catch(e=>{ document.getElementById('ewStatus').innerHTML='<span style="color:var(--red)">✗ '+e.message+'</span>'; });
}

function fetchEwelinkDevices(){
  document.getElementById('ewStatus').textContent = 'Fetching devices...';
  fetch(API_BASE+'/api/sensors/devices',{headers:{'Authorization':'Bearer '+(localStorage.getItem('ekl_token')||'')}})
  .then(r=>r.json())
  .then(d=>{
    if(d.devices){
      document.getElementById('ewStatus').innerHTML = '<span style="color:var(--green)">✓ '+d.devices.length+' devices</span>';
      // Show assignable devices
      const tempDevices = d.devices.filter(dev=>dev.temp!=null||dev.humidity!=null);
      if(tempDevices.length > 0){
        document.getElementById('ewDeviceList').innerHTML = '<div style="margin-top:10px"><div style="font-size:10px;color:var(--mute);margin-bottom:8px;text-transform:uppercase;letter-spacing:1px">Assign sensors to farms:</div>'+
          tempDevices.map(dev=>`
            <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--b1)">
              <div style="flex:1"><div style="font-size:12px;font-family:'Exo 2',sans-serif;font-weight:600">${dev.name}</div>
              <div style="font-size:10px;color:var(--mute)">${dev.temp!=null?dev.temp+'°C':''} ${dev.humidity!=null?dev.humidity+'%':''}</div></div>
              <select style="background:var(--bg);border:1px solid var(--b1);border-radius:4px;padding:4px 8px;color:var(--txt);font-size:11px" id="assign_${dev.id}">
                <option value="">— No farm —</option>
                ${agents.map(a=>`<option value="${a.id}">${a.name}</option>`).join('')}
              </select>
              <button class="abtn" onclick="assignSensor('${dev.id}')">Assign</button>
            </div>`
          ).join('')+'</div>';
      } else {
        document.getElementById('ewDeviceList').innerHTML = '<div style="font-size:11px;color:var(--mute);margin-top:8px">No temperature/humidity sensors found. Add them in the eWeLink app first.</div>';
      }
    }
  })
  .catch(e=>{ document.getElementById('ewStatus').innerHTML='<span style="color:var(--red)">✗ '+e.message+'</span>'; });
}

function assignSensor(deviceId){
  const sel = document.getElementById('assign_'+deviceId);
  const farmId = sel?.value;
  if(!farmId){toast('Select a farm first','var(--warn)');return;}
  fetch(API_BASE+'/api/sensors/assign',{
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':'Bearer '+(localStorage.getItem('ekl_token')||'')},
    body:JSON.stringify({farm_id:farmId, device_ids:[deviceId]})
  })
  .then(r=>r.json())
  .then(d=>{ if(d.ok) toast('✓ Sensor assigned to farm','var(--green)'); })
  .catch(e=>toast('Error: '+e.message,'var(--red)'));
}
function liveUpdate(){if(isCustomer)renderPortal();}

// ════════════════════════════════════════════════════════════
// SCADA — Lanli Hydro System (SP Cloud Integration)
// MY16-542 · 1to1-535 · 1to1-288
// ════════════════════════════════════════════════════════════

// ── SCADA Login ───────────────────────────────────────────
function scadaLogin(){
  const u=document.getElementById('scadaUser').value.trim();
  const p=document.getElementById('scadaPass').value;
  const e=document.getElementById('scadaLoginErr');
  e.style.display='none';
  if(!u||!p){e.textContent='Enter username and password';e.style.display='block';return;}
  e.style.display='block';e.style.color='var(--cyan)';e.textContent='Authenticating...';
  // First check if backend is awake
  fetch(API_BASE+'/health')
  .then(r=>r.json())
  .then(()=>{
    // Backend is up — now try SCADA login
    return fetch(API_BASE+'/api/scada/login',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({username:u,password:p})
    });
  })
  .then(r=>{
    const ct=r.headers.get('content-type')||'';
    if(!ct.includes('json')){
      throw new Error('Backend returned an error page. Go to Railway dashboard and check the Logs tab for errors.');
    }
    return r.json();
  })
  .then(d=>{
    if(d.ok&&d.token){
      scadaToken=d.token;
      localStorage.setItem('scada_token',d.token);
      e.style.display='none';
      showScadaDashboard();
    } else {
      e.style.color='var(--red)';
      e.textContent=d.error||'Login failed.';
    }
  })
  .catch(err=>{
    e.style.color='var(--red)';
    if(err.message.includes('fetch')||err.message.includes('Failed')){
      e.textContent='Cannot reach server. Check: 1) Railway is running  2) API URL is set in Settings';
    } else {
      e.textContent=err.message;
    }
  });
}

function scadaLogout(){
  scadaToken=null;localStorage.removeItem('scada_token');clearInterval(scadaRefInt);
  document.getElementById('scadaLoginPanel').style.display='block';
  document.getElementById('scadaDashboard').style.display='none';
  document.getElementById('scadaUser').value='';document.getElementById('scadaPass').value='';
}

function showScadaDashboard(){
  document.getElementById('scadaLoginPanel').style.display='none';
  document.getElementById('scadaDashboard').style.display='block';
  // iDOSP URL is fixed — no need to restore
  // Load manual readings
  scadaRefresh();
  clearInterval(scadaRefInt);scadaRefInt=setInterval(scadaRefresh,30000);
}

function scadaRefresh(){
  if(!scadaToken)return;
  fetch(API_BASE+'/api/scada/overview',{headers:{'x-scada-token':scadaToken}})
  .then(r=>{if(r.status===401){scadaLogout();return Promise.reject();}return r.json();})
  .then(d=>{
    scadaData=d.cabinets||{};
    renderScadaDashboard();
    const lu=document.getElementById('scadaLastUpdate');
    if(lu)lu.textContent=new Date().toLocaleTimeString();
  }).catch(()=>{});
}

// ── SP Cloud embed ────────────────────────────────────────

// Open iDOSP in new tab — requires VPN (Netherlands) active on device
function openIdospTab(){
  window.open(IDOSP_URL, '_blank');
  toast('Opening iDOSP — make sure VPN (Netherlands) is active &#x1F1F3;&#x1F1F1;', 'var(--purple)');
}

// Compatibility stubs
function loadIdosp(){ openIdospTab(); }
function saveSpUrl(){ openIdospTab(); }
function loadSpFrame(){ openIdospTab(); }
function reloadSpFrame(){ openIdospTab(); }
function openSpCloud(){ openIdospTab(); }

// ── Cabinet cards (manual readings) ──────────────────────
function renderScadaDashboard(){
  let tp=0,co=0,te=0,ac=0;
  const grid=document.getElementById('cabinetGrid');
  if(!grid)return;

  grid.innerHTML=Object.entries(LANLI).map(([id,cab])=>{
    const d=scadaData[id]||{};
    const ok=d.ok!==false&&!d.error;
    const pw=d.power_kw||0;
    const pct=Math.min(100,(pw/(cab.rated_w/1000))*100);
    const ip=getCabIp(id);
    const sl=d.alarm_count>0?'ALARM':pw>0?'RUNNING':ok?'STANDBY':'OFFLINE';
    const sc=d.alarm_count>0?'var(--red)':pw>0?'var(--green)':ok?'var(--warn)':'var(--mute)';
    if(ok&&pw>0){tp+=pw;te+=d.energy_kwh||0;ac+=d.alarm_count||0;co++;}

    let html='<div style="background:var(--s1);border:1px solid '+(ok?'rgba(0,200,255,.2)':'rgba(255,45,85,.2)')+';border-radius:10px;overflow:hidden">';
    html+='<div style="background:var(--s2);padding:12px 14px;border-bottom:1px solid var(--b1)">';
    html+='<div style="display:flex;align-items:center;gap:8px">';
    html+='<div><div style="font-family:Orbitron,sans-serif;font-size:12px;font-weight:700;color:var(--cyan)">'+cab.model+'</div>';
    html+='<div style="font-size:10px;color:var(--mute)">'+cab.name+' &middot; '+cab.rated_w+'W'+(ip?' &middot; '+ip:'')+'</div></div>';
    html+='<span style="margin-left:auto;font-family:Share Tech Mono,monospace;font-size:10px;font-weight:700;color:'+sc+';border:1px solid '+sc+';border-radius:3px;padding:2px 7px">'+sl+'</span>';
    html+='</div>';
    if(ok&&pw>0) html+='<div style="margin-top:8px"><div style="height:3px;background:var(--b1);border-radius:2px;overflow:hidden"><div style="height:100%;width:'+pct.toFixed(0)+'%;background:linear-gradient(90deg,var(--green),var(--cyan))"></div></div><div style="font-size:9px;color:var(--mute);text-align:right;margin-top:2px">'+pct.toFixed(0)+'% load</div></div>';
    html+='</div>';

    if(ok&&pw>0){
      html+='<div style="padding:12px;text-align:center;border-bottom:1px solid var(--b1)">';
      html+='<div style="font-family:Share Tech Mono,monospace;font-size:40px;color:var(--cyan);line-height:1">'+pw.toFixed(3)+'</div>';
      html+='<div style="font-size:10px;color:var(--mute)">kW</div></div>';
      html+='<div style="display:grid;grid-template-columns:1fr 1fr 1fr;border-bottom:1px solid var(--b1)">';
      [['V',(d.voltage_v||0).toFixed(1)],['A',(d.current_a||0).toFixed(2)],['Hz',(d.frequency_hz||0).toFixed(2)]].forEach(([u,v])=>{
        html+='<div style="padding:9px;text-align:center;border-right:1px solid var(--b1)"><div style="font-size:9px;color:var(--mute)">'+u+'</div><div style="font-family:Share Tech Mono,monospace;font-size:15px;color:var(--txt)">'+v+'</div></div>';
      });
      html+='</div>';
      html+='<div style="padding:8px 12px;display:flex;justify-content:space-between;font-size:10px">';
      html+='<span style="color:var(--mute)">Flow: <span style="color:var(--cyan)">'+(d.flow_rate>0?d.flow_rate.toFixed(1)+' m³/h':'--')+'</span></span>';
      html+='<span style="color:var(--mute)">Temp: <span style="color:'+(d.temp_c>=70?'var(--red)':d.temp_c>=55?'var(--warn)':'var(--green)')+'">'+(d.temp_c>0?d.temp_c+'&deg;C':'--')+'</span></span>';
      html+='<span style="color:'+(d.alarm_count>0?'var(--red)':'var(--green)')+'">'+( d.alarm_count>0?'⚠ '+d.alarm_count+' Alarm':'✓ OK')+'</span>';
      html+='</div>';
    } else {
      html+='<div style="padding:32px;text-align:center;color:var(--mute)">';
      html+='<div style="font-size:28px;margin-bottom:8px">'+(ip?'📡':'🔌')+'</div>';
      html+='<div style="font-size:11px">'+(ip?d.error||'Cannot connect':'Configure IP below')+'</div>';
      html+='<button class="btn btn-sm scada-retry-btn" style="margin-top:10px">↺ Retry</button>';
      html+='<button class="btn btn-sm" style="margin-top:10px;margin-left:6px">&#x270F; Manual</button>';
      html+='</div>';
    }
    html+='</div>';
    return html;
  }).join('');

  // Attach SCADA button handlers
  if(grid){
    grid.querySelectorAll('.scada-manual-btn').forEach(function(b){b.addEventListener('click',function(){openManualEntry(this.dataset.cabid);});});
    grid.querySelectorAll('.scada-retry-btn').forEach(function(b){b.addEventListener('click',function(){scadaRefresh();});});
  }
  const s=(id,v)=>{const el=document.getElementById(id);if(el)el.textContent=v;};
  s('scadaTotalPower',tp.toFixed(3));s('scadaCabOnline',co);s('scadaTodayEnergy',te.toFixed(2));s('scadaAlarmCount',ac);
}
// ── Network Scanner ───────────────────────────────────────
function startScan(){
  if(scanning){ stopScan(); return; }
  const farmId = document.getElementById('scanVia')?.value;
  const rawSubnets = document.getElementById('scanRange')?.value || '';
  if(!farmId || farmId === 'local'){ alert('Select a farm agent from the dropdown first.'); return; }

  const subnets = rawSubnets.split(/[,\n]+/).map(function(s){ return s.trim(); }).filter(Boolean);
  if(subnets.length === 0){
    alert('Enter the IP ranges before scanning.\n\nExample:\n192.168.70.1-255\n192.168.44.1-255');
    return;
  }

  // Lock farm for this scan session
  currentScanFarmId   = farmId;
  currentScanFarmName = (agents.find(function(a){ return a.id === farmId; }) || {}).name || farmId;

  scanning = true; scanFound = 0; scanSecs = 0;
  _lastScanResults = {};
  const fg = document.getElementById('foundGrid'); if(fg) fg.innerHTML = '';
  const sl = document.getElementById('scanLog');   if(sl) sl.innerHTML = '';

  const btn = document.getElementById('scanBtn'); if(btn) btn.textContent = '■ Stop';
  const ssl = document.getElementById('scanCurrentSubnet'); if(ssl) ssl.style.display = 'block';

  addLog('info','[ AGENT  ] ' + currentScanFarmName + ' (' + currentScanFarmId + ')');
  subnets.forEach(function(s){ addLog('info','[ TARGET ] ' + s); });

  const token = localStorage.getItem('ekl_token');
  fetch(API_BASE + '/api/scanner/start', {
    method: 'POST',
    headers: {'Content-Type':'application/json','Authorization':'Bearer ' + (token || '')},
    body: JSON.stringify({ farm_id: farmId, subnets: subnets, subnet: subnets[0], ports:[4028,80,8080], timeout: 2000 })
  })
  .then(function(r){ return r.json(); })
  .then(function(d){
    if(d.error){ addLog('err','[ ERROR ] ' + d.error); stopScan(); return; }
    currentScanSession = d.session_id;
    addLog('ok','[ OK ] Session: ' + d.session_id);
    scanInt  = setInterval(function(){ pollScanResults(d.session_id); }, 1500);
    scanTInt = setInterval(function(){
      scanSecs++;
      const t = document.getElementById('scanTime');
      if(t) t.textContent = scanSecs + 's';
    }, 1000);
  })
  .catch(function(e){ addLog('err','[ ERROR ] ' + e.message); stopScan(); });
}

function pollScanResults(sessionId){
  const token = localStorage.getItem('ekl_token');
  fetch(API_BASE + '/api/scanner/results/' + sessionId, {headers:{'Authorization':'Bearer ' + (token || '')}})
  .then(function(r){ return r.json(); })
  .then(function(d){
    if(d.found && d.found.length > 0){
      d.found.forEach(function(m){
        if(!_lastScanResults[m.ip]){
          _lastScanResults[m.ip] = m;
          scanFound++;
          addFoundCard(m);
          addLog('ok','[ FOUND ] ' + m.ip + ' — ' + (m.model || 'ASIC'));
          const fc = document.getElementById('foundCount'); if(fc) fc.textContent = scanFound;
        }
      });
    }
    if(d.progress !== undefined){
      const pf = document.getElementById('progFill');   if(pf) pf.style.width = d.progress + '%';
      const ss = document.getElementById('scanStatus'); if(ss) ss.textContent = d.progress + '%';
    }
    if(d.scanned !== undefined){
      const sc = document.getElementById('scanCount'); if(sc) sc.textContent = d.scanned;
    }
    if(d.current_subnet){
      const cs = document.getElementById('scanCurrentSubnet');
      if(cs) cs.textContent = 'Scanning: ' + d.current_subnet;
    }
    if(d.done && d.progress >= 100){
      addLog('ok','[ DONE ] ' + scanFound + ' miners found');
      stopScan();
    }
  })
  .catch(function(){});
}

function addSubnet(cidr){
  const el = document.getElementById('scanRange');
  if(!el) return;
  const existing = el.value.trim();
  if(existing.includes(cidr)) return;
  el.value = existing ? (existing + '\n' + cidr) : cidr;
}

function clearScanLog(){
  const sl = document.getElementById('scanLog'); if(sl) sl.innerHTML = '';
  const fg = document.getElementById('foundGrid'); if(fg) fg.innerHTML = '';
  _lastScanResults = {};
  scanFound = 0;
  const fc = document.getElementById('foundCount'); if(fc) fc.textContent = '0';
}


// ── Remaining handler stubs ──────────────────────────────
function onScanViaChange(sel){ onAgentSelect(sel || document.getElementById('scanVia')); }
function saveAssign(){ applyAssign(); }
function testConn(){
  fetch(API_BASE + '/health')
    .then(function(r){ return r.json(); })
    .then(function(d){ alert('✓ Connected!\nServer v' + (d.version||'1.0') + ' · ' + (d.agents||0) + ' agents'); })
    .catch(function(e){ alert('✗ Cannot reach ' + API_BASE + '\n' + e.message); });
}
function toggleCfg(id){ const el = document.getElementById(id); if(el) el.style.display = el.style.display === 'none' ? 'block' : 'none'; }
function toggleFb(){ const el = document.getElementById('failoverFields'); if(el) el.style.display = el.style.display === 'none' ? 'block' : 'none'; }
function toggleSelAll(cb){
  document.querySelectorAll('.worker-check').forEach(function(c){ c.checked = cb.checked; });
}
function applyPreset(url, user){
  const u = document.getElementById('poolUrl'); if(u) u.value = url;
  const w = document.getElementById('poolUser'); if(w) w.value = user || '';
}
function setWF(val){
  const el = document.getElementById('wfInput'); if(el) el.value = val;
}
function bulkReboot(){
  const checked = Array.from(document.querySelectorAll('.worker-check:checked')).map(function(c){ return c.dataset.wid; });
  if(checked.length === 0){ alert('Select miners first'); return; }
  if(!confirm('Reboot ' + checked.length + ' miners?')) return;
  toast('Reboot command sent to ' + checked.length + ' miners', 'var(--cyan)');
}
function doAction(action, wid){
  const w = workers.find(function(x){ return x.id === (wid || activeWid); });
  if(!w){ toast('No miner selected', 'var(--warn)'); return; }
  const token = localStorage.getItem('ekl_token');
  fetch(API_BASE + '/api/actions/' + action, {
    method: 'POST',
    headers: {'Content-Type':'application/json','Authorization':'Bearer ' + (token||'')},
    body: JSON.stringify({ ip: w.ip, farm_id: w.farm_id, worker_id: w.id })
  })
  .then(function(r){ return r.json(); })
  .then(function(d){
    if(d.ok) toast('✓ ' + action + ' sent to ' + w.name, 'var(--green)');
    else toast('✗ ' + (d.error || 'Failed'), 'var(--red)');
  })
  .catch(function(e){ toast('✗ ' + e.message, 'var(--red)'); });
}


function addToFleetDirect(ip, model, farmId, farmName){
  const miner = (_lastScanResults && _lastScanResults[ip]) ? _lastScanResults[ip] : {};
  workers = workers.filter(function(w){ return w.ip !== ip; });
  var algo    = miner.algo || getAlgoFromModel(model || miner.model || '');
  var brand   = miner.brand || detectBrand(miner.model || model);
  var ghAlgos = ['Scrypt','KHeavyHash','X11','Blake2B','Ethash','Equihash'];
  var hrUnit  = miner.hr_unit || (ghAlgos.includes(algo) ? 'GH/s' : 'TH/s');
  var hrDisp  = (miner.hr_display && miner.hr_display !== '—') ? miner.hr_display : (miner.hashrate > 0 ? miner.hashrate.toFixed(2) + ' ' + hrUnit : '—');
  workers.push({
    id: 'w-' + ip.replace(/\./g, '-'),
    name: miner.worker ? miner.worker.split('.').pop() : ip.replace(/\./g, '-'),
    model: miner.model || model || 'ASIC Miner',
    brand: brand, algo: algo, ip: ip,
    hashrate: miner.hashrate || 0, hr_unit: hrUnit, hr_display: hrDisp,
    temp: miner.temp || 0, fan: miner.fan || 0, power: miner.power || 0,
    status: 'online', pool: miner.pool || '—', pool_url: miner.pool || '',
    pool_user: miner.worker || '', uptime: miner.uptime || '—',
    farm: farmName, farm_id: farmId,
    cid: '', disabled: false, led: false, firmware: miner.firmware || '—',
    accepted: miner.accepted || 0, rejected: miner.rejected || 0,
    hw_errors: miner.hw_errors || 0, source: 'scan',
    added_at: new Date().toISOString()
  });
  saveFleet();
  updateNavCount();
  showSavedIndicator();
  setTimeout(saveFleetToBackend, 500);
  try { renderWorkers(); } catch(e) {}
  try { renderDash(); } catch(e) {}
  toast('✓ ' + ip + ' → ' + farmName, 'var(--green)');
}

function addFoundCard(m){
  const g=document.getElementById('foundGrid');
  if(!g)return;
  const d=document.createElement('div');
  d.className='card';
  const model=m.model||m.type||'ASIC Miner';
  const brand=m.brand||'';
  const hr=m.hr_display||(m.hashrate>0?m.hashrate.toFixed(2)+(m.hr_unit||' TH/s'):'—');
  const farmId=currentScanFarmId||(agents.length>0?agents[0].id:'unknown');
  const farmName=currentScanFarmName||(agents.find(function(a){return a.id===farmId;})||{name:'Farm'}).name;

  let h='<div class="card-head"><span class="sdot on"></span>';
  h+='<div style="flex:1"><div style="font-family:Share Tech Mono,monospace;font-size:12px;color:var(--cyan);font-weight:700">'+m.ip+'</div>';
  h+='<div style="font-size:10px;color:var(--mute)">'+brand+' '+model+' &middot; '+farmName+'</div></div>';
  h+='<span class="badge bgn">ONLINE</span></div>';
  h+='<div class="card-body">';
  h+='<div class="card-row"><span class="ck">Model</span><span class="cv">'+model+'</span></div>';
  h+='<div class="card-row"><span class="ck">Hashrate</span><span class="cv g">'+hr+'</span></div>';
  h+='<div class="card-row"><span class="ck">Temp</span><span class="cv">'+( m.temp>0?m.temp+'&deg;C':'—')+'</span></div>';
  h+='<div class="card-row"><span class="ck">Pool</span><span class="cv" style="font-size:10px">'+(m.pool||'—')+'</span></div>';
  h+='</div><div class="card-foot">';
  h+='<button class="btn btn-sm btn-g add-fleet-btn">+ Add to Fleet</button>';
  h+='</div>';
  d.innerHTML=h;

  // Attach click handler safely (no inline onclick)
  const btn=d.querySelector('.add-fleet-btn');
  const capIp=m.ip, capModel=model, capFarmId=farmId, capFarmName=farmName;
  btn.addEventListener('click',function(){ addToFleetDirect(capIp,capModel,capFarmId,capFarmName); });
  g.appendChild(d);
}
