
// ── Missing functions prepended ──────────────────────────

// API and URL setup
const API_BASE = sanitizeUrl(window.EKL_API_BASE)
  || sanitizeUrl(localStorage.getItem('ekl_api_base'))
  || 'http://localhost:3001';

// ── Coin ticker ──────────────────────────────────────────
// Symbols, icons and colours only. Prices are NOT stored here —
// they come live from CoinGecko via /api/market/prices. There is
// deliberately no fallback price: an out-of-date number that looks
// current is worse than no number at all, so an unavailable feed
// shows "—" instead.
const COIN_META = {
  BTC: {ico:'₿', col:'#f7931a'},
  ETH: {ico:'Ξ', col:'#627eea'},
  LTC: {ico:'Ł', col:'#bfbbbb'},
  KAS: {ico:'⬡', col:'#49dbc0'},
};
let coinPrices = null;   // {BTC:{usd,change_24h}, …} once loaded
const CC = ['#e74c3c','#3498db','#2ecc71','#9b59b6','#e67e22','#1abc9c','#f39c12','#34495e'];

// App state
let isCustomer = false, currentUser = null, activeWid = null;
let loginTab = 'admin';
let agents = [], workers = [], customers = [];
// Declared here (not down near its other filter-by-site code) because
// renderWorkers() -> refreshAgentFilterOptions() reads it, and renderWorkers()
// can run very early (e.g. from a fast-resolving backend load callback) —
// while the script is still executing further down the file. A `let`
// declared later is in the temporal dead zone until its own line runs, so
// that early call hit "Cannot access 'workerAgentFilter' before
// initialization" and aborted mid-render, which is why the Workers table
// silently stopped refreshing and the Power panel kept recomputing off of
// whatever the last successful render had left behind.
let workerAgentFilter = 'all';
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
// (stub sdot removed — full version defined later)
function detectBrand(model){ const m=(model||'').toLowerCase(); if(m.includes('antminer')||m.includes('bitmain')) return 'Bitmain'; if(m.includes('whatsminer')||m.includes('microbt')) return 'MicroBT'; if(m.includes('avalon')) return 'Canaan'; if(m.includes('goldshell')) return 'Goldshell'; if(m.includes('elphapex')||m.includes('dg1')||m.includes('dg-1')) return 'ElphaPEX'; return ''; }

// ── Navigation ────────────────────────────────────────────
// (stub nav removed — full version defined later)

// (stub showPage removed — full version defined later)

// ── Login tab ─────────────────────────────────────────────
// (stub setLTab removed — full version defined later)

// ── Render functions ──────────────────────────────────────
function renderAll(){
  try{ renderDash(); }catch(e){ console.error('renderDash:',e); }
  try{ renderPowerPanel(); }catch(e){ console.error('renderPowerPanel:',e); }
  try{ renderWorkers(); }catch(e){ console.error('renderWorkers:',e); }
  try{ renderAgents(); }catch(e){}
  try{ renderCustomers(); }catch(e){}
  try{ updateNavCount(); }catch(e){}
}
// ── Column sorting state ────────────────────────────────────
let workerSortField = null;
let workerSortDir    = 1; // 1 = ascending, -1 = descending

let _sortHandlersAttached = false;
function attachSortHandlers(){
  if (_sortHandlersAttached) return; // only need to bind once — headers are static
  document.querySelectorAll('.sortable-th').forEach(function(th){
    th.addEventListener('click', function(){ sortWorkersBy(this.dataset.sort); });
  });
  _sortHandlersAttached = true;
}

function toggleTailscaleMode(checked){
  localStorage.setItem('use_tailscale_webui', checked ? 'true' : 'false');
  toast(checked ? '✓ Tailscale direct mode enabled on this device' : 'Tunnel mode restored', 'var(--green)');
}

function editSerialAndMac(wid){
  const w = workers.find(function(x){ return x.id === wid; });
  if (!w) return;

  const newSerial = prompt('Serial Number for ' + (w.name || w.ip) + ':', w.serial || '');
  if (newSerial === null) return; // cancelled
  const trimmedSerial = newSerial.trim();
  w.serial = trimmedSerial || null;
  w.serial_manual = !!trimmedSerial; // marks it as locked — auto-detection will never overwrite this again

  const newMac = prompt('MAC Address for ' + (w.name || w.ip) + ':', w.mac || '');
  if (newMac !== null) {
    const trimmedMac = newMac.trim();
    w.mac = trimmedMac || null;
    w.mac_manual = !!trimmedMac;
  }

  saveFleet();
  saveFleetToBackend();
  _workersHash = '';
  renderWorkers();
  toast('✓ Saved for ' + (w.name || w.ip), 'var(--green)');
}

function sortWorkersBy(field){
  if (workerSortField === field) workerSortDir *= -1;
  else { workerSortField = field; workerSortDir = 1; }
  _workersHash = ''; // force rebuild
  renderWorkers();
}

function getSortValue(w, field){
  switch(field){
    case 'name':     return (w.name || '').toLowerCase();
    case 'serial':   return (w.serial || w.mac || '').toLowerCase();
    case 'brand':    return ((w.brand||'') + ' ' + (w.model||'')).toLowerCase();
    case 'ip':       return w.ip ? w.ip.split('.').map(function(n){return n.padStart(3,'0');}).join('.') : '';
    case 'farm':     return (w.farm || '').toLowerCase();
    case 'cid':      { const c = customers.find(function(x){return x.id===w.cid;}); return c ? c.name.toLowerCase() : ''; }
    case 'hashrate': return w.hashrate || 0;
    case 'temp':     return w.temp || 0;
    case 'fan':      return w.fan || 0;
    case 'pool':     return (w.pool || '').toLowerCase();
    case 'status':   return effectiveStatus(w);
    default:         return '';
  }
}

function updateSortArrows(){
  document.querySelectorAll('.sort-arrow').forEach(function(el){ el.textContent = ''; });
  if (workerSortField) {
    const arrow = document.getElementById('arrow-' + workerSortField);
    if (arrow) arrow.textContent = workerSortDir === 1 ? '▲' : '▼';
  }
}

function renderWorkers() {
  const tb = document.getElementById('workersTbody');
  if (!tb) return;
  // Always rebuild — no hash guard (was preventing updates)
  const A = function(fid){ return agents.find(function(a){ return a.id === fid; }); };
  const C = function(id){ return customers.find(function(x){ return x.id === id; }); };

  // Apply active filter + search first, then sort
  refreshAgentFilterOptions();

  let displayWorkers = workers.filter(function(w){ return matchesWorkerFilter(w, workerFilter); });
  if (workerAgentFilter !== 'all') {
    displayWorkers = displayWorkers.filter(function(w){ return w.farm_id === workerAgentFilter; });
  }
  displayWorkers = filterWorkersBySearch(displayWorkers);
  if (workerSortField) {
    displayWorkers.sort(function(a, b){
      const va = getSortValue(a, workerSortField);
      const vb = getSortValue(b, workerSortField);
      if (va < vb) return -1 * workerSortDir;
      if (va > vb) return  1 * workerSortDir;
      return 0;
    });
  }
  updateSortArrows();

  if (workers.length === 0) {
    tb.innerHTML = '<tr><td colspan="12" style="text-align:center;padding:40px;color:var(--mute)">'
      + '<div style="font-size:28px;margin-bottom:10px">&#x26CF;</div>'
      + 'No miners in fleet yet.<br><span style="font-size:11px">Use <strong>Network Scanner</strong> to discover and add miners.</span>'
      + '</td></tr>';
    return;
  }

  // Filters can legitimately match nothing. Without this the table just
  // goes blank, which looks like the machines were lost rather than
  // hidden by a filter the user forgot was on.
  if (displayWorkers.length === 0) {
    tb.innerHTML = '<tr><td colspan="12" style="text-align:center;padding:36px;color:var(--mute)">'
      + 'No machines match the current filters.'
      + '<br><span style="font-size:11px">' + workers.length + ' machine(s) in the fleet — '
      + '<a href="#" onclick="clearWorkerFilters();return false" style="color:var(--cyan)">clear filters</a></span>'
      + '</td></tr>';
    return;
  }

  tb.innerHTML = displayWorkers.map(function(w) {
    const ag  = A(w.farm_id);
    const cust= C(w.cid);
    const tc   = w.temp >= 90 ? 'color:var(--red)' : w.temp >= 80 ? 'color:var(--warn)' : '';
    const eSt  = effectiveStatus(w);
    const agentDown = w.farm_id && !isAgentOnline(w.farm_id) && !w.disabled;
    const st   = w.disabled ? 'REPAIR' : agentDown ? 'AGENT OFFLINE' : eSt.toUpperCase();
    const sb   = w.disabled ? 'bor' : eSt === 'online' ? 'bgn' : 'brn';
    // Disabled machines are greyed out via the .wdis class rather than
    // an inline style, so the row banding in CSS can be overridden
    // cleanly instead of the two fighting each other.
    const rowClass = w.disabled ? ' class="wdis"' : '';
    return '<tr' + rowClass + '>'
      + '<td><input type="checkbox" class="worker-check" data-wid="' + w.id + '" style="accent-color:var(--cyan)"></td>'
      + '<td><div style="font-family:Share Tech Mono,monospace;font-weight:700;font-size:12px;color:' + (w.disabled ? 'var(--mute)' : 'var(--cyan)') + '">' + (w.name || '—') + '</div>'
      + '<span class="sdot ' + sdot(w) + '" style="margin-right:4px"></span><span style="font-size:9px;color:var(--mute)">' + (w.algo || '') + '</span>'
      + '</td>'
      + '<td title="MAC: ' + (w.mac || 'unknown') + ' — click to edit" class="sn-edit-cell" data-wid="' + w.id + '" style="font-family:Share Tech Mono,monospace;font-size:10px;cursor:pointer">'
      +   (w.serial ? w.serial : '<span style="color:var(--mute)">&#x270E; add</span>')
      +   (w.mac ? '<div style="font-size:9px;color:var(--mute)">' + w.mac + '</div>' : '<div style="font-size:9px;color:var(--mute)">&#x270E; add MAC</div>')
      + '</td>'
      + '<td style="font-size:11px;max-width:90px;width:90px;white-space:normal;word-break:break-word;overflow-wrap:break-word">' + cleanBrandModel(w.brand) + '<br><span style="color:var(--mute);font-size:10px">' + cleanBrandModel(w.model) + '</span></td>'
      + '<td style="font-family:Share Tech Mono,monospace;font-size:11px">' + (w.ip || '—') + '</td>'
      + '<td style="font-size:11px">' + (w.farm || (ag ? ag.name : '—')) + '</td>'
      + '<td style="font-size:11px">' + (cust ? cust.name : '<span style="color:var(--mute)">—</span>') + '</td>'
      + '<td style="color:var(--green);font-family:Share Tech Mono,monospace;font-size:11px">' + (eSt === 'online' ? hrDisplay(w) : '<span style="color:var(--mute)">—</span>') + '</td>'
      + '<td style="' + tc + ';font-family:Share Tech Mono,monospace;font-size:11px">' + (eSt === 'online' && w.temp > 0 ? w.temp + '\u00b0C' : '—') + '</td>'
      + '<td style="font-family:Share Tech Mono,monospace;font-size:11px">' + (eSt === 'online' && w.fan > 0 ? w.fan : '—') + '</td>'
      + '<td style="font-size:10px;color:var(--mute)">' + (w.pool || '—') + '</td>'
      + '<td><span class="badge ' + sb + '">' + st + '</span></td>'
      + '<td><button class="abtn open-ctrl-btn" data-wid="' + w.id + '">Manage</button></td>'
      + '</tr>';
  }).join('');

  tb.querySelectorAll('.open-ctrl-btn').forEach(function(b){
    b.addEventListener('click', function(){ openCtrl(this.dataset.wid); });
  });
  tb.querySelectorAll('.sn-edit-cell').forEach(function(td){
    td.addEventListener('click', function(){ editSerialAndMac(this.dataset.wid); });
  });
  tb.querySelectorAll('.worker-check').forEach(function(c){
    c.addEventListener('change', updateMergeSelBtn);
  });

  // Update badge counts (accounts for agent connectivity).
  // Scoped to the selected site so the counts describe what's on
  // screen — a fleet-wide "212 online" above one site's 40 machines
  // is just confusing. Status filter and search are deliberately NOT
  // applied here: these badges ARE the status breakdown.
  const scope = workerAgentFilter === 'all'
    ? workers
    : workers.filter(function(w){ return w.farm_id === workerAgentFilter; });
  const on  = scope.filter(function(w){ return effectiveStatus(w) === 'online'; }).length;
  const off = scope.filter(function(w){ return effectiveStatus(w) !== 'online' && !w.disabled; }).length;
  const dis = scope.filter(function(w){ return w.disabled; }).length;
  const eOn = document.getElementById('wOnlineBadge');  if (eOn) eOn.textContent = on;
  const eOf = document.getElementById('wOfflineBadge'); if (eOf) eOf.textContent = off;
  const eDs = document.getElementById('wDisBadge');     if (eDs) { eDs.textContent = dis; eDs.style.display = dis ? '' : 'none'; }
}

function fmtUptime(seconds){
  if (!seconds && seconds !== 0) return '—';
  const h = Math.floor(seconds/3600), m = Math.floor((seconds%3600)/60);
  return h > 0 ? (h+'h '+m+'m') : (m+'m');
}
function fmtAgo(iso){
  if (!iso) return '—';
  const s = Math.floor((Date.now() - new Date(iso).getTime())/1000);
  if (s < 60) return s+'s ago';
  if (s < 3600) return Math.floor(s/60)+'m ago';
  return Math.floor(s/3600)+'h ago';
}

function renderAgents() {
  const el = document.getElementById('agentGrid');
  if (!el) return;
  el.innerHTML = agents.length === 0
    ? '<div style="text-align:center;padding:40px;color:var(--mute)"><div style="font-size:32px;margin-bottom:12px">📡</div><div>No agents connected.<br>Run the agent on your farm PC to connect.</div></div>'
    : agents.map(function(a){
      const crashWarn = a.crash_count_5m > 0;
      return '<div class="card"><div class="card-head"><span class="sdot ' + (a.online ? 'on' : 'off') + '"></span>'
      + '<div><div style="font-family:Exo 2,sans-serif;font-weight:700">' + a.name + '</div><div style="font-size:10px;color:var(--mute)">' + (a.subnet || '') + (a.agent_version?' &middot; v'+a.agent_version:'') + '</div></div>'
      + '<span class="badge ' + (a.online ? 'bgn' : 'brn') + '" style="margin-left:auto">' + (a.online ? 'ONLINE' : 'OFFLINE') + '</span></div>'
      + '<div class="card-body"><div class="card-row"><span class="ck">Farm ID</span><span class="cv" style="font-family:Share Tech Mono,monospace">' + a.id + '</span></div>'
      + '<div class="card-row"><span class="ck">Host</span><span class="cv">' + (a.hostname || '—') + '</span></div>'
      + '<div class="card-row"><span class="ck">Miners</span><span class="cv g">' + workers.filter(function(w){return w.farm_id === a.id;}).length + '</span></div>'
      + (a.updater_uptime !== undefined ? '<div class="card-row"><span class="ck">Supervisor Uptime</span><span class="cv">' + fmtUptime(a.updater_uptime) + '</span></div>' : '')
      + (a.last_checkin_at ? '<div class="card-row"><span class="ck">Last Check-in</span><span class="cv">' + fmtAgo(a.last_checkin_at) + '</span></div>' : '')
      + (a.last_update_at ? '<div class="card-row"><span class="ck">Last Updated</span><span class="cv">' + fmtAgo(a.last_update_at) + '</span></div>' : '')
      + (crashWarn ? '<div class="card-row"><span class="ck" style="color:var(--warn)">⚠ Crashes (5m)</span><span class="cv" style="color:var(--warn)">' + a.crash_count_5m + '</span></div>' : '')
      + '</div>'
      + '<div class="card-foot"><button class="btn btn-sm scan-btn" data-aid="' + a.id + '">&#x25B6; Scan</button>'
      + '<button class="btn btn-sm cfg-btn" data-aid="' + a.id + '" data-name="' + a.name.replace(/"/g,'') + '" data-subnet="' + (a.subnet||'').replace(/"/g,'') + '">&#x2699; IP Ranges</button>'
      + (a.online ? '' : '<button class="btn btn-sm btn-r rm-btn" data-aid="' + a.id + '">&#x2715; Remove</button>')
      + '</div></div>';
    }).join('');
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
  const el4 = document.getElementById('ctPortal'); if (el4) el4.textContent = customers.filter(function(c){ return c.portal; }).length;
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
        + '<div class="card-foot"><button class="btn btn-sm qa-btn" data-cid="' + c.id + '">&#x26CF; Assign Miners</button><button class="btn btn-sm edit-cust-btn" data-cid="' + c.id + '" style="margin-left:6px">&#x270E; Edit</button></div></div>';
    }).join('');

  // Wire up each card's "Assign Miners" button (was rendered but never
  // actually listened for — clicking it silently did nothing before)
  el.querySelectorAll('.qa-btn').forEach(function(btn){
    btn.addEventListener('click', function(){ quickAssign(this.dataset.cid); });
  });
  el.querySelectorAll('.edit-cust-btn').forEach(function(btn){
    btn.addEventListener('click', function(){ openEditCustomer(this.dataset.cid); });
  });

  // Populate the "Select Customer" dropdown in the Assign panel with
  // every real customer — it previously only ever had the placeholder
  // "Choose customer..." option and nothing else, so there was never
  // anything selectable there at all.
  const sel = document.getElementById('assignSel');
  if (sel) {
    const prevValue = sel.value;
    sel.innerHTML = '<option value="">Choose customer...</option>'
      + customers.map(function(c){ return '<option value="' + c.id + '">' + c.name + '</option>'; }).join('');
    if (customers.some(function(c){ return c.id === prevValue; })) sel.value = prevValue;
  }
}

// Build the current live alert list — used by both the badge and the Alerts page
function computeAlerts() {
  const liveAlerts = [];
  workers.forEach(function(w) {
    if (w.temp >= 90) liveAlerts.push({ico:'🔴', msg: w.name + ': Critical temp ' + w.temp + '°C', time: 'Live'});
    if (w.status === 'offline' && !w.disabled) liveAlerts.push({ico:'🔴', msg: w.name + ' (' + w.ip + ') offline', time: 'Live'});
    if (w.disabled) liveAlerts.push({ico:'🟠', msg: w.name + ' disabled: ' + (w.disabled_reason || 'Repair'), time: w.disabled_at || '—'});
  });
  agents.forEach(function(a) { if (!a.online) liveAlerts.push({ico:'🟡', msg: 'Agent offline: ' + a.name, time: 'Live'}); });
  return liveAlerts.concat(alertsData);
}

// Update both badges (sidebar + bottom nav) — safe to call from anywhere, anytime
function updateAlertBadges() {
  const all = computeAlerts();
  const badge = document.getElementById('alertBadge');
  if (badge) { badge.textContent = all.length; badge.style.display = all.length ? '' : 'none'; }
  const badgeBn = document.getElementById('alertBadgeBn');
  if (badgeBn) { badgeBn.textContent = all.length; badgeBn.style.display = all.length ? '' : 'none'; }
  return all;
}

function renderAlerts() {
  const all = updateAlertBadges();
  const el = document.getElementById('allAlerts');
  if (!el) return; // Alerts page not open — badges are already updated above
  el.innerHTML = all.length === 0
    ? '<div style="text-align:center;padding:30px;color:var(--mute)">No alerts. All systems normal.</div>'
    : all.map(function(a) {
        return '<div style="padding:10px 16px;border-bottom:1px solid rgba(26,42,58,.4);display:flex;gap:8px"><span style="font-size:14px">' + a.ico + '</span><div><div style="font-size:12px;color:var(--txt)">' + a.msg + '</div><div style="font-size:10px;color:var(--mute)">' + a.time + '</div></div></div>';
      }).join('');
}

// Copy a pool address to the clipboard. Uses the modern API where
// available and falls back for older/non-secure contexts, since a
// silent failure here means someone pastes nothing into a miner.
function copyPoolUrl(btn, url) {
  function done(ok) {
    const original = btn.textContent;
    btn.textContent = ok ? 'Copied' : 'Failed';
    setTimeout(function(){ btn.textContent = original; }, 1400);
    if (ok) toast('Copied: ' + url, 'var(--green)');
    else    toast('Could not copy \u2014 long-press the address to select it instead', 'var(--warn)');
  }
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(url).then(function(){ done(true); }, function(){ done(false); });
    return;
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = url;
    ta.style.position = 'fixed'; ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    done(ok);
  } catch(e) { done(false); }
}

function renderPools() {
  const el = document.getElementById('poolsGrid');
  if (!el) return;

  // Real, verified stratum connection details. Pool operators change
  // server addresses occasionally — if a miner fails to connect,
  // check the pool's own help center for the current address before
  // assuming something else is wrong. Where a pool genuinely doesn't
  // offer 3 separate addresses (or doesn't publish one publicly at
  // all), that's noted honestly rather than filled in with a guess.
  const pools = [
    {
      name: 'F2Pool', color: '#00d4ff',
      coins: [
        { coin: 'BTC', urls: ['stratum+tcp://btc.f2pool.com:1314', 'stratum+tcp://btc.f2pool.com:25', 'stratum+tcp://btc.f2pool.com:3333'] },
        { coin: 'LTC', urls: ['stratum+tcp://ltc.f2pool.com:8888', 'stratum+tcp://ltc.f2pool.com:5200', 'stratum+tcp://ltc.f2pool.com:3335'] },
      ],
      note: 'Regional servers also available (Asia/EU/NA) — see f2pool.com for the closest one.'
    },
    {
      name: 'AntPool', color: '#e67e22',
      coins: [
        { coin: 'BTC', urls: ['stratum+tcp://stratum.antpool.com:3333', 'stratum+tcp://stratum.antpool.com:443', 'stratum+tcp://stratum.antpool.com:25'] },
        { coin: 'LTC', urls: ['stratum+tcp://stratum-ltc.antpool.com:8888', 'stratum+tcp://stratum-ltc.antpool.com:443', 'stratum+tcp://stratum-ltc.antpool.com:25'] },
      ],
      note: 'Enter the same worker name across all three — as long as one address is reachable, mining continues uninterrupted.'
    },
    {
      name: 'ViaBTC', color: '#00c896',
      coins: [
        { coin: 'BTC', urls: ['stratum+tcp://btc.viabtc.io:3333', 'stratum+tcp://btc.viabtc.cc:3333', 'stratum+tcp://btc.viabtc.top:3333'] },
        { coin: 'LTC', urls: ['stratum+tcp://ltc.viabtc.io:3333', 'stratum+tcp://ltc.viabtc.io:443'], partial: true },
      ],
      note: ''
    },
    {
      name: 'Luxor', color: '#a855f7',
      coins: [
        { coin: 'BTC', urls: ['stratum+tcp://btc.global.luxor.tech:700'], single: true },
        { coin: 'LTC/DOGE (merged)', urls: ['stratum+tcp://ltc.global.luxor.tech:700'], single: true },
      ],
      note: 'Luxor uses one global address per coin by design — it automatically routes to the nearest region internally, so there\'s no separate Pool 2/3 to enter.'
    },
    {
      name: 'Binance Pool', color: '#f0b90b',
      coins: [
        { coin: 'BTC', urls: ['stratum+tcp://sha256.poolbinance.com:8888', 'stratum+tcp://sha256.poolbinance.com:3333', 'stratum+tcp://sha256.poolbinance.com:443'] },
      ],
      note: 'BTC only — Binance Pool does not currently offer a public LTC pool.'
    },
    {
      name: 'Foundry USA', color: '#3b82f6',
      coins: [
        { coin: 'BTC', urls: ['Provided only after KYC-approved account setup'], unavailable: true },
      ],
      note: 'Foundry USA is institutional-grade and requires an approved account (KYC/AML) before it discloses any stratum address — nothing is published publicly. Contact Foundry directly to onboard.'
    },
    {
      name: 'BitFuFu', color: '#ff6b35',
      coins: [
        { coin: 'BTC', urls: ['Shown inside your account dashboard after logging in'], unavailable: true },
      ],
      note: 'BitFuFu does not publish a fixed public stratum address — log in at bitfufu.com to find yours. BTC only.'
    },
  ];

  el.innerHTML = '<div style="grid-column:1/-1;background:rgba(255,45,85,.06);border:1px solid rgba(255,45,85,.25);border-radius:6px;padding:10px 14px;font-size:11px;color:var(--red);margin-bottom:4px">'
    + '⚠ <strong>Poolin</strong> is not listed — it filed for Chapter 11 bankruptcy and fully shut down mining operations in July 2026. Any stored connection to it will not work.'
    + '</div>'
    + pools.map(function(p){
    return '<div class="card">'
      + '<div class="card-head"><div class="av" style="background:' + p.color + ';width:38px;height:38px;font-size:13px">' + p.name.slice(0,2).toUpperCase() + '</div>'
      + '<div><div style="font-family:Exo 2,sans-serif;font-weight:700;font-size:14px">' + p.name + '</div></div></div>'
      + '<div class="card-body">'
      + p.coins.map(function(c){
          if (c.unavailable) {
            return '<div style="margin-bottom:10px">'
              + '<div style="font-size:10px;color:var(--mute);text-transform:uppercase;letter-spacing:1px;margin-bottom:2px">' + c.coin + '</div>'
              + '<div style="font-size:11px;color:var(--warn);font-style:italic">' + c.urls[0] + '</div></div>';
          }
          return '<div style="margin-bottom:10px">'
            + '<div style="font-size:10px;color:var(--mute);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">' + c.coin + '</div>'
            + c.urls.map(function(u, i){
                // Tap-to-copy: these get typed into a miner's config by
                // hand otherwise, where one wrong character means the
                // machine silently mines to nothing.
                return '<div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">'
                  + '<div style="flex:1;font-family:Share Tech Mono,monospace;font-size:11px;color:var(--cyan);word-break:break-all">'
                  +   '<span style="color:var(--mute)">Pool ' + (i+1) + ':</span> ' + u + '</div>'
                  + '<button class="abtn" style="flex:none" onclick="copyPoolUrl(this,\'' + u.replace(/'/g, "\\'") + '\')">Copy</button>'
                  + '</div>';
              }).join('')
            + (c.partial ? '<div style="font-size:10px;color:var(--mute);margin-top:2px">Only 2 verified addresses for this coin — no separate 3rd server confirmed.</div>' : '')
            + '</div>';
        }).join('')
      + (p.note ? '<div style="font-size:10px;color:var(--mute);margin-top:6px;padding-top:8px;border-top:1px solid var(--b1)">' + p.note + '</div>' : '')
      + '</div></div>';
  }).join('');
}

// ── Site power draw ──────────────────────────────────────────
// Nameplate wattage per model, read from asicminervalue.com
// (checked September 2026). These are the manufacturer's rated
// figures at stock settings — they are the FALLBACK, used only for
// machines whose firmware doesn't report its own power draw.
//
// Where a miner does report it, that measured figure is used instead,
// because it reflects what the machine is actually pulling right now:
// underclocked or overclocked units, degraded PSUs and hot-weather
// derating all move real draw well away from the spec sheet. Which of
// the two a number came from is shown in the panel rather than being
// quietly averaged together, since one is a measurement and the other
// is an assumption.
//
// Keys are model names with everything but letters and digits removed,
// so they survive the many ways firmware writes a model string
// ("Antminer L9", "ANTMINER-L9", "Bitmain Antminer L9 (17Gh)").
const POWER_SPECS = {
  // ── Bitmain, Scrypt (LTC/DOGE) ──
  'antminerl9':          3570,   // 17 Gh/s
  'antminerl7':          3425,   // 9.16 Gh/s
  'antminerl11hyd2u':    5775,   // 35 Gh/s
  'antminerl11hyd6u':    5676,   // 33 Gh/s
  // ── Bitmain, SHA-256 ──
  'antminers21pro':      3510,   // 245 Th/s
  'antminers21xpplushyd': 5500,  // 500 Th/s ("S21 XP+ Hyd")
  'antminers21exphyd3u': 11180,  // 860 Th/s
  'antminers21':         3550,   // 200 Th/s
  'antminers23hyd3u':    11020,  // 1.16 Ph/s
  'antminers23exphyd2u': 8650,   // 865 Th/s
  'antminers23xphyd':    5340,   // 600 Th/s
  'antminers23hyd':      5510,   // 580 Th/s
  'antminers19jproplus': 3355,   // 122 Th/s ("S19j Pro+")
  'antminers19jpro':     3068,   // 104 Th/s
  'antminers19pro':      3250,   // 110 Th/s
  'antminers19xp':       3010,   // 140 Th/s
  // ── Bitmain, other algorithms ──
  'antminerka3':         3154,   // 166 Th/s KHeavyHash
  'antminerz15pro':      2780,
  'antminerz15k':        2483,
  'antminerz15':         1510,
  'antminerz11':         1418,
  'antminerx9':          2472,
  // ── ElphaPEX, Scrypt ──
  'elphapexdg1plus':     3920,   // 14 Gh/s
  'elphapexdghome1':      620,   // 2 Gh/s
  'elphapexdg1':         3420,   // 11 Gh/s
  'dg1plus':             3920,   // firmware often omits the brand
  'dghome1':              620,
  'dg1':                 3420,
  // ── MicroBT ──
  'whatsminerm79s':     20000,
  'whatsminerm50s':      3276,
  'whatsminerm50':       3276,
  // ── Bitdeer SealMiner ──
  'sealminera4ultrahydro': 8372,
  'sealminera4prohydro':   7412,
  'sealminera3prohydro':   8250,
  'sealminerdl1hydro':     7823,
  'sealminerdl1air':       3725,
  'a9zmaster':           1550,
};

// Longest key first, so "Antminer S21 Pro" can't be matched by the
// shorter "antminers21" entry that its name also contains.
const POWER_SPEC_KEYS = Object.keys(POWER_SPECS).sort(function(a,b){ return b.length - a.length; });

// "+" is part of the model name, not punctuation — an S21 XP+ Hyd and
// an S21 XP Hyd are different machines with different draws, and a DG1+
// pulls 500W more than a DG1. Stripping it as a symbol made the plus
// variants silently match the cheaper base model, so it becomes a word
// before the rest of the punctuation is removed.
function normalizeModelKey(s) {
  return String(s || '').toLowerCase().replace(/\+/g, 'plus').replace(/[^a-z0-9]/g, '');
}

function specWattsFor(w) {
  const hay = normalizeModelKey((w.brand || '') + ' ' + (w.model || ''));
  if (!hay) return 0;
  for (let i = 0; i < POWER_SPEC_KEYS.length; i++) {
    if (hay.indexOf(POWER_SPEC_KEYS[i]) !== -1) return POWER_SPECS[POWER_SPEC_KEYS[i]];
  }
  return 0;
}

// ── Hand-entered wattage, held per model and shared fleet-wide ────
// Loaded from the backend so the figure typed on one device applies on
// every other one, and to machines at every site.
let modelPowerOverrides = [];   // [{ model_key, watts, label, set_by }]

// The model string a machine reports is what everything here keys off.
function modelKeyOf(w) {
  return normalizeModelKey((w.brand || '') + ' ' + (w.model || ''));
}

// Finding the entry that applies to a machine is not a plain lookup,
// because the same machine is described differently by different
// firmware: one agent reports "Antminer L9", another "Antminer L9
// (17Gh)". Keyed strictly, a figure entered from one site would leave
// the other site's identical machines uncounted — which defeats the
// point of storing it per model.
//
// So an entry matches when either name contains the other: an entry
// saved as "Antminer DR7" covers a machine another agent reports as
// "Bitmain Antminer DR7 (5Th)", and one saved with the brand attached
// still covers a machine whose firmware omits it. Matching only on a
// shared prefix was not enough — the brand sits at the FRONT of the
// name, so the two strings differ exactly where a prefix test looks.
//
// Exact matches are preferred, then the longest partial, so a specific
// "DG1+" entry always beats a general "DG1" one rather than the two
// fighting over the same machines.
const MIN_OVERRIDE_KEY_LEN = 3;   // "l9" would match far too much

function overrideWattsFor(w) {
  const key = modelKeyOf(w);
  if (!key || !modelPowerOverrides.length) return null;

  let best = null, bestLen = -1;
  for (let i = 0; i < modelPowerOverrides.length; i++) {
    const o = modelPowerOverrides[i];
    const k = o.model_key;
    if (!k || k.length < MIN_OVERRIDE_KEY_LEN) continue;
    if (k === key) return o;                                  // exact — done
    const related = key.indexOf(k) !== -1 || k.indexOf(key) !== -1;
    if (related && k.length > bestLen) { best = o; bestLen = k.length; }
  }
  return best;
}

// How many machines in the fleet a given entry is currently covering —
// shown in the UI so a too-broad entry is visible rather than silently
// inflating a site total.
function machinesCoveredBy(modelKey) {
  return workers.filter(function(w){
    const o = overrideWattsFor(w);
    return o && o.model_key === modelKey;
  }).length;
}

function loadModelPower(cb) {
  const token = localStorage.getItem('ekl_token');
  if (!token || !API_BASE || API_BASE.includes('localhost')) { if (cb) cb(); return; }
  fetch(API_BASE + '/api/power/models', { headers: { 'Authorization': 'Bearer ' + token } })
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(d){
      if (d && d.ok && Array.isArray(d.models)) modelPowerOverrides = d.models;
      if (cb) cb();
    })
    .catch(function(){ if (cb) cb(); });
}

// Save one model's wattage. The backend stores it centrally, so this
// is what makes the figure reach the other sites and devices.
// `force` = trust this OVER the miner's own live reading, for a model
// whose firmware reports a number but the number is wrong.
function saveModelPower(modelLabel, watts, force) {
  const token = localStorage.getItem('ekl_token');
  const w = Number(watts);
  if (!isFinite(w) || w <= 0) { toast('Enter the wattage as a number', 'var(--warn)'); return; }
  toast('Saving ' + modelLabel + '...', 'var(--cyan)');
  fetch(API_BASE + '/api/power/models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (token||'') },
    body: JSON.stringify({ model: modelLabel, watts: w, force: !!force }),
  })
    .then(function(r){ return r.json().then(function(d){ return { ok: r.ok, d: d }; }); })
    .then(function(res){
      if (!res.ok) { toast(res.d.error || 'Could not save', 'var(--red)'); return; }
      modelPowerOverrides = res.d.models || [];
      const n = machinesCoveredBy(normalizeModelKey(modelLabel));
      toast(modelLabel + ' set to ' + Math.round(w) + 'W' + (force ? ' (overriding reported readings)' : '') + ' — applied to ' + n + ' machine(s) fleet-wide', 'var(--green)');
      renderPowerPanel();
      try { renderDash(); } catch(e) {}
    })
    .catch(function(e){ toast('Could not save: ' + e.message, 'var(--red)'); });
}

function removeModelPower(modelKey) {
  if (!confirm('Remove the hand-entered power for this model?\nIts machines go back to the built-in spec figure, or become uncounted if there isn\'t one.')) return;
  const token = localStorage.getItem('ekl_token');
  fetch(API_BASE + '/api/power/models/' + encodeURIComponent(modelKey), {
    method: 'DELETE',
    headers: { 'Authorization': 'Bearer ' + (token||'') },
  })
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(d){
      if (d && d.ok) { modelPowerOverrides = d.models || []; toast('Removed', 'var(--warn)'); renderPowerPanel(); }
      else toast('Could not remove', 'var(--red)');
    })
    .catch(function(){ toast('Could not remove', 'var(--red)'); });
}

// Called from the inline "Set"/"Update"/"Apply" buttons in the power panel
function submitModelPower(btn) {
  const wrap  = btn.closest('[data-model]');
  if (!wrap) return;
  const input = wrap.querySelector('input[type=number]');
  const check = wrap.querySelector('input[type=checkbox]');
  saveModelPower(wrap.getAttribute('data-model'), input ? input.value : '', check ? check.checked : false);
}

// The "+ Correct a model" mini form — for a model that already reports
// a number (so it never shows up in the "not counted" list) but the
// number is wrong. Distinct from the quick-add rows above it, which are
// only for models with no reading at all.
function showAddModelCorrection() {
  const el = document.getElementById('addModelCorrectionForm');
  if (el) el.style.display = 'flex';
  const btn = document.getElementById('addModelCorrectionBtn');
  if (btn) btn.style.display = 'none';
  const inp = document.getElementById('newCorrModel');
  if (inp) inp.focus();
}
function submitNewModelCorrection() {
  const model = document.getElementById('newCorrModel');
  const watts = document.getElementById('newCorrWatts');
  const force = document.getElementById('newCorrForce');
  if (!model || !model.value.trim()) { toast('Enter the model name as it appears in the fleet', 'var(--warn)'); return; }
  saveModelPower(model.value.trim(), watts ? watts.value : '', force ? force.checked : true);
  model.value = ''; if (watts) watts.value = '';
  const el = document.getElementById('addModelCorrectionForm');
  if (el) el.style.display = 'none';
  const btn = document.getElementById('addModelCorrectionBtn');
  if (btn) btn.style.display = '';
}

// Firmware occasionally reports a power field that isn't watts at all
// — a raw register value, a sentinel like 65535, or 0 when the PSU
// isn't being read. Anything outside the range a single ASIC could
// plausibly draw is treated as no reading rather than trusted, so one
// bad sensor can't add a megawatt to a site total.
const PLAUSIBLE_WATTS_MIN = 100;
const PLAUSIBLE_WATTS_MAX = 25000;

// Watts for ONE machine, with where the figure came from.
// A machine that isn't running draws nothing worth counting.
function minerWatts(w) {
  const st = effectiveStatus(w);
  if (st !== 'online' && st !== 'warn') return { watts: 0, source: 'off' };

  const manual = overrideWattsFor(w);

  // A "forced" entry means someone checked this model against reality
  // (a clamp meter, the PDU) and found the firmware's own number
  // wrong — not missing, WRONG. That is a different problem from a
  // model that never reports at all, and the ordinary "measured beats
  // everything" rule can't fix it, because the bad reading still looks
  // like a plausible wattage and passes the sanity check below. So a
  // forced entry is checked first and, when it applies, wins outright.
  if (manual && manual.force && manual.watts > 0) {
    return { watts: manual.watts, source: 'manual', key: manual.model_key, forced: true };
  }

  const measured = Number(w.power) || 0;
  if (measured >= PLAUSIBLE_WATTS_MIN && measured <= PLAUSIBLE_WATTS_MAX) {
    return { watts: measured, source: 'measured' };
  }
  // A figure someone entered for this model beats the built-in spec
  // table: they measured these actual machines with a clamp meter or
  // read the PDU, which is worth more than a manufacturer's rating —
  // and it's the only way a model the table doesn't know gets counted.
  if (manual && manual.watts > 0) return { watts: manual.watts, source: 'manual', key: manual.model_key };
  const spec = specWattsFor(w);
  if (spec > 0) return { watts: spec, source: 'spec' };
  return { watts: 0, source: 'unknown' };
}

// Whole-fleet roll-up, and the same figures per site.
// `unknown` is carried through deliberately: a machine whose model
// isn't in the table and which doesn't report its own draw contributes
// nothing to the total, and a site total that silently omits machines
// is worse than one that says how many it omitted.
function computeSitePower() {
  const byFarm = {};
  const total  = { watts: 0, running: 0, measured: 0, manual: 0, spec: 0, unknown: 0, unknownModels: {} };

  workers.forEach(function(w) {
    const fid  = w.farm_id || 'unassigned';
    if (!byFarm[fid]) {
      // NOTE: this used to call a helper named A(fid) to fall back to
      // the connected agent's name when a worker record had no .farm
      // string of its own. That A() only ever existed as a LOCAL const
      // inside renderWorkers() — a different function entirely — so
      // calling it here threw "ReferenceError: A is not defined" the
      // instant any worker with a falsy .farm was encountered. Because
      // JS's || short-circuits, that only fired for SOME fleets (any
      // worker missing .farm), which is exactly why this looked like it
      // came and went rather than being reliably broken. The whole
      // computeSitePower() call — and therefore the entire "Power
      // Consumption by Site" panel — silently failed every time it hit
      // one of these workers, which also matches machines whose NAME
      // wasn't showing on the Workers page: same underlying gap, a
      // worker record missing metadata the agent hasn't backfilled yet.
      const agent = agents.find(function(a){ return a.id === fid; });
      byFarm[fid] = { id: fid, name: w.farm || (agent ? agent.name : fid),
                      watts: 0, running: 0, measured: 0, manual: 0, spec: 0, unknown: 0, unknownModels: {} };
    }
    const f = byFarm[fid];
    if (w.farm && !f.name) f.name = w.farm;

    const r = minerWatts(w);
    if (r.source === 'off') return;

    f.running++;     total.running++;
    f.watts += r.watts; total.watts += r.watts;
    if (r.source === 'measured') { f.measured++; total.measured++; }
    else if (r.source === 'manual') { f.manual++; total.manual++; }
    else if (r.source === 'spec') { f.spec++; total.spec++; }
    else {
      f.unknown++; total.unknown++;
      const label = (cleanBrandModel(w.brand) + ' ' + cleanBrandModel(w.model)).trim() || 'Unknown';
      f.unknownModels[label] = (f.unknownModels[label] || 0) + 1;
      total.unknownModels[label] = (total.unknownModels[label] || 0) + 1;
    }
  });

  return { total: total, farms: Object.values(byFarm).sort(function(a,b){ return b.watts - a.watts; }) };
}

// ── Every distinct model actually running in the fleet ─────────────
// The per-model power tools only ever surfaced a model AFTER it showed
// up as "not counted" or after someone already knew its exact name well
// enough to type it in. Neither helps the person who just wants to see
// what's out there and fix a number — they don't necessarily know that
// the miner reports itself as "Antminer S21 Hyd" rather than "S21
// Hydro". So this reads the models straight out of the fleet itself:
// every group here is a model that is DEFINITELY at one of the sites,
// under the exact name its own firmware reports.
function modelBreakdown() {
  const groups = {};
  workers.forEach(function(w) {
    const key = modelKeyOf(w);
    if (!key) return;
    if (!groups[key]) groups[key] = { key: key, label: '', count: 0, running: 0, farms: {}, sample: null };
    const g = groups[key];
    g.count++;
    const st = effectiveStatus(w);
    if (st === 'online' || st === 'warn') g.running++;
    const lbl = (cleanBrandModel(w.brand) + ' ' + cleanBrandModel(w.model)).trim();
    if (lbl.length > g.label.length) g.label = lbl;               // fullest name seen wins
    if (w.farm) g.farms[w.farm] = true;
    // Prefer a running machine as the sample used to look up its
    // current power — that's the reading someone would actually see
    // if they opened this machine right now.
    if (!g.sample || (st === 'online' && effectiveStatus(g.sample) !== 'online')) g.sample = w;
  });
  return Object.keys(groups).map(function(k){ return groups[k]; });
}

// What a machine of this model would draw right now, for display —
// same precedence minerWatts() uses, just evaluated against the
// sample machine as though it were online, so an editor can see (and
// fix) a model's figure even while every unit of it happens to be
// powered down for maintenance.
function modelEffectivePower(g) {
  if (!g.sample) return { watts: 0, source: 'unknown' };
  const probe = Object.assign({}, g.sample, { status: 'online', disabled: false });
  return minerWatts(probe);
}

function fmtKW(watts) {
  if (!watts) return '0 kW';
  if (watts >= 1e6) return (watts / 1e6).toFixed(2) + ' MW';
  return (watts / 1000).toFixed(watts >= 100000 ? 0 : 1) + ' kW';
}

// The rate is typed once and kept on the device — it's a local tariff,
// not fleet data, and it differs per site operator.
function getElecRate() {
  const el = document.getElementById('pwrRate');
  const v  = el ? parseFloat(el.value) : parseFloat(localStorage.getItem('ekl_elec_rate'));
  return (isFinite(v) && v >= 0) ? v : null;
}
function onElecRateChange() {
  const el = document.getElementById('pwrRate');
  if (el) localStorage.setItem('ekl_elec_rate', el.value);
  renderPowerPanel();
}

function renderPowerPanel() {
  const p = computeSitePower();

  // Headline card on the stats row
  const sv = document.getElementById('dPower');
  if (sv) sv.textContent = fmtKW(p.total.watts).replace(/ (kW|MW)$/, '');
  const su = document.getElementById('dPowerUnit');
  if (su) su.textContent = (p.total.watts >= 1e6 ? 'MW' : 'kW') + ' drawn now';

  const body = document.getElementById('powerBySite');
  if (!body) return;

  const rate = getElecRate();
  const dayKwh = function(watts){ return (watts / 1000) * 24; };

  if (p.total.running === 0) {
    body.innerHTML = '<div style="padding:18px;text-align:center;color:var(--mute);font-size:12px">'
      + 'No machines are running, so nothing is drawing power right now.</div>';
    return;
  }

  let rows = p.farms.filter(function(f){ return f.running > 0; }).map(function(f) {
    const cost = rate !== null ? ('$' + (dayKwh(f.watts) * rate).toFixed(2)) : '<span style="color:var(--mute)">—</span>';
    const gap  = f.unknown > 0
      ? '<div style="font-size:9px;color:var(--warn)">' + f.unknown + ' machine(s) not counted</div>' : '';
    return '<tr>'
      + '<td style="font-family:Exo 2,sans-serif;font-weight:600">' + escHtml(f.name) + gap + '</td>'
      + '<td style="font-family:Share Tech Mono,monospace;font-size:11px">' + f.running + '</td>'
      + '<td style="font-family:Share Tech Mono,monospace;font-size:12px;color:var(--cyan);font-weight:700">' + fmtKW(f.watts) + '</td>'
      + '<td style="font-family:Share Tech Mono,monospace;font-size:11px">' + dayKwh(f.watts).toFixed(0) + ' kWh</td>'
      + '<td style="font-family:Share Tech Mono,monospace;font-size:11px">' + cost + '</td>'
      + '</tr>';
  }).join('');

  const totalCost = rate !== null ? ('$' + (dayKwh(p.total.watts) * rate).toFixed(2)) : '<span style="color:var(--mute)">—</span>';
  rows += '<tr style="border-top:2px solid var(--b2)">'
    + '<td style="font-family:Exo 2,sans-serif;font-weight:700;color:var(--txt)">ALL SITES</td>'
    + '<td style="font-family:Share Tech Mono,monospace;font-size:11px;font-weight:700">' + p.total.running + '</td>'
    + '<td style="font-family:Share Tech Mono,monospace;font-size:13px;color:var(--green);font-weight:700">' + fmtKW(p.total.watts) + '</td>'
    + '<td style="font-family:Share Tech Mono,monospace;font-size:11px;font-weight:700">' + dayKwh(p.total.watts).toFixed(0) + ' kWh</td>'
    + '<td style="font-family:Share Tech Mono,monospace;font-size:11px;font-weight:700">' + totalCost + '</td>'
    + '</tr>';

  // How the total was arrived at. Stated plainly so the number can be
  // trusted or challenged, rather than presented as a single figure of
  // unknown provenance.
  let prov = '<span style="color:var(--green)">' + p.total.measured + ' measured</span>';
  if (p.total.manual > 0)  prov += ' &middot; <span style="color:var(--purple,var(--cyan))">' + p.total.manual + ' entered by hand</span>';
  if (p.total.spec > 0)    prov += ' &middot; <span style="color:var(--cyan)">' + p.total.spec + ' from model spec</span>';
  if (p.total.unknown > 0) prov += ' &middot; <span style="color:var(--warn)">' + p.total.unknown + ' unknown, not counted</span>';

  // Every model actually seen in the fleet, with what it's currently
  // costed at and an edit control right there — so fixing a number
  // never depends on first knowing the exact model name to type. This
  // is the answer to "which models are even at my sites": every row
  // here came from a real machine, not from a name someone remembered.
  let modelTable = '';
  if (!isCustomer) {
    const groups = modelBreakdown().sort(function(a, b) {
      const ea = modelEffectivePower(a), eb = modelEffectivePower(b);
      const unkA = ea.source === 'unknown' ? 0 : 1, unkB = eb.source === 'unknown' ? 0 : 1;
      if (unkA !== unkB) return unkA - unkB;           // uncounted models float to the top
      return b.count - a.count;
    });

    const rowsHtml = groups.map(function(g) {
      const eff = modelEffectivePower(g);
      const override = modelPowerOverrides.find(function(o){ return o.model_key === g.key; });
      const farmNames = Object.keys(g.farms).sort().join(', ') || '—';

      let badge;
      if (eff.forced)                badge = '<span style="padding:1px 6px;border-radius:3px;background:rgba(255,176,32,.15);border:1px solid rgba(255,176,32,.35);color:var(--warn);font-size:9px;white-space:nowrap">OVERRIDE</span>';
      else if (eff.source==='measured') badge = '<span style="padding:1px 6px;border-radius:3px;background:rgba(0,220,130,.12);border:1px solid rgba(0,220,130,.3);color:var(--green);font-size:9px;white-space:nowrap">MEASURED</span>';
      else if (eff.source==='manual')   badge = '<span style="padding:1px 6px;border-radius:3px;background:rgba(120,160,255,.12);border:1px solid rgba(120,160,255,.3);color:#8fb0ff;font-size:9px;white-space:nowrap">MANUAL</span>';
      else if (eff.source==='spec')     badge = '<span style="padding:1px 6px;border-radius:3px;background:rgba(0,200,255,.1);border:1px solid rgba(0,200,255,.3);color:var(--cyan);font-size:9px;white-space:nowrap">SPEC</span>';
      else                               badge = '<span style="padding:1px 6px;border-radius:3px;background:rgba(255,176,32,.15);border:1px solid rgba(255,176,32,.35);color:var(--warn);font-size:9px;white-space:nowrap">NOT COUNTED</span>';

      const prefillWatts = override ? Number(override.watts) : (eff.watts > 0 ? eff.watts : '');
      const rowBg = eff.source === 'unknown' ? 'background:rgba(255,176,32,.05)' : '';

      return '<tr data-model="' + escHtml(g.label) + '" style="' + rowBg + '">'
        + '<td style="font-family:Share Tech Mono,monospace;font-size:11px;padding:6px 8px">' + escHtml(g.label || g.key)
        +   '<div style="font-size:9px;color:var(--mute)">' + escHtml(farmNames) + '</div></td>'
        + '<td style="font-size:11px;padding:6px 8px">' + g.count + (g.running < g.count ? ' <span style="color:var(--mute)">(' + g.running + ' running)</span>' : '') + '</td>'
        + '<td style="padding:6px 8px">' + badge + '</td>'
        + '<td style="padding:6px 8px">'
        +   '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">'
        +     '<input type="number" min="50" max="25000" step="10" value="' + prefillWatts + '" placeholder="watts"'
        +       ' onkeydown="if(event.key===\'Enter\'){submitModelPower(this.closest(\'tr\').querySelector(\'.mp-update\'));}"'
        +       ' style="width:76px;background:var(--bg);border:1px solid var(--b1);border-radius:5px;padding:4px 6px;color:var(--txt);font-family:Share Tech Mono,monospace;font-size:11px;outline:none">'
        +     '<label style="display:flex;align-items:center;gap:3px;font-size:9px;color:var(--mute);white-space:nowrap;cursor:pointer" title="Trust this figure even when the miner reports its own (wrong) reading">'
        +       '<input type="checkbox" ' + (override && override.force ? 'checked' : '') + ' style="accent-color:var(--warn)">override</label>'
        +     '<button class="abtn mp-update" onclick="submitModelPower(this)">Save</button>'
        +     (override ? '<button class="abtn" onclick="removeModelPower(\'' + escHtml(g.key) + '\')" style="border-color:var(--red);color:var(--red)">&times;</button>' : '')
        +   '</div>'
        + '</td>'
        + '</tr>';
    }).join('');

    // Overrides that were typed in but no longer match any machine
    // currently in the fleet — a typo, or a model that's since been
    // retired. Surfaced rather than silently ignored, since an entry
    // like this looks like it's doing something and isn't.
    const matchedKeys = {};
    groups.forEach(function(g){ if (modelPowerOverrides.find(function(o){return o.model_key===g.key;})) matchedKeys[g.key] = true; });
    const orphans = modelPowerOverrides.filter(function(o){ return !matchedKeys[o.model_key]; });
    const orphanHtml = orphans.length ? ('<div style="margin-top:10px;padding:8px 10px;background:rgba(255,176,32,.06);border:1px solid rgba(255,176,32,.2);border-radius:6px">'
      + '<div style="font-size:10px;color:var(--warn);margin-bottom:6px">Saved but matching no machine right now &mdash; check for a typo, or remove it:</div>'
      + orphans.map(function(o){
          return '<div style="display:flex;align-items:center;gap:8px;font-size:11px;font-family:Share Tech Mono,monospace;margin-top:4px">'
            + '<span style="flex:1">' + escHtml(o.label || o.model_key) + ' &mdash; ' + Number(o.watts) + 'W' + (o.force?' (override)':'') + '</span>'
            + '<button class="abtn" onclick="removeModelPower(\'' + escHtml(o.model_key) + '\')" style="border-color:var(--red);color:var(--red)">&times; Remove</button>'
            + '</div>';
        }).join('')
      + '</div>') : '';

    modelTable = '<div style="margin-top:10px">'
      + '<table class="tbl" style="width:100%"><thead><tr>'
      +   '<th style="text-align:left">Model</th><th style="text-align:left">Machines</th>'
      +   '<th style="text-align:left">Source</th><th style="text-align:left">Watts / Edit</th>'
      + '</tr></thead><tbody>' + rowsHtml + '</tbody></table>'
      + orphanHtml
      + '<div style="margin-top:10px">'
      +   '<button class="abtn" id="addModelCorrectionBtn" onclick="showAddModelCorrection()">+ Add a model not listed above</button>'
      +   '<div id="addModelCorrectionForm" style="display:none;margin-top:8px;align-items:center;gap:8px;flex-wrap:wrap">'
      +     '<input id="newCorrModel" type="text" placeholder="Model name (e.g. Antminer S21 Hyd)"'
      +       ' style="flex:1;min-width:160px;background:var(--bg);border:1px solid var(--b1);border-radius:5px;padding:5px 8px;color:var(--txt);font-family:Share Tech Mono,monospace;font-size:11px;outline:none">'
      +     '<input id="newCorrWatts" type="number" min="50" max="25000" step="10" placeholder="watts"'
      +       ' style="width:84px;background:var(--bg);border:1px solid var(--b1);border-radius:5px;padding:5px 8px;color:var(--txt);font-family:Share Tech Mono,monospace;font-size:11px;outline:none">'
      +     '<label style="display:flex;align-items:center;gap:4px;font-size:9px;color:var(--mute);white-space:nowrap;cursor:pointer">'
      +       '<input id="newCorrForce" type="checkbox" checked style="accent-color:var(--warn)"> override live reading</label>'
      +     '<button class="abtn" onclick="submitNewModelCorrection()" style="border-color:var(--green);color:var(--green)">Save</button>'
      +   '</div>'
      + '</div>'
      + '</div>';
  }

  // Details (the full model list) are used rarely once the fleet's
  // models are filled in, so they're tucked behind a toggle rather than
  // always taking up space. The summary line stays visible either way —
  // it's the one-glance check that the total can be trusted — and
  // remembers open/closed per device.
  const hasDetails = !!modelTable;
  const open = localStorage.getItem('ekl_power_details_open') === '1';

  body.innerHTML =
      '<table class="tbl" style="width:100%"><thead><tr>'
    + '<th style="text-align:left">Site</th><th style="text-align:left">Running</th>'
    + '<th style="text-align:left">Power Draw</th><th style="text-align:left">Per Day</th>'
    + '<th style="text-align:left">Cost / Day</th>'
    + '</tr></thead><tbody>' + rows + '</tbody></table>'
    + '<div style="margin-top:8px;font-size:10px;color:var(--mute);display:flex;align-items:center;gap:8px;flex-wrap:wrap">'
    +   '<span>Based on: ' + prov + '</span>'
    +   (hasDetails
          ? '<a href="#" onclick="togglePowerDetails();return false" style="color:var(--cyan);white-space:nowrap">'
            + (open ? '&#x25B2; Hide details' : '&#x25BC; Show details') + '</a>'
          : '')
    + '</div>'
    + (hasDetails
        ? '<div id="powerDetails" style="display:' + (open ? '' : 'none') + '">' + modelTable + '</div>'
        : '');
}

function togglePowerDetails() {
  const open = localStorage.getItem('ekl_power_details_open') === '1';
  localStorage.setItem('ekl_power_details_open', open ? '0' : '1');
  renderPowerPanel();
}

// ── Profitability Calculator ─────────────────────────────────
// Model/algo/hashrate/power specs below were read directly from
// asicminervalue.com (the top 20 models it server-renders by
// default, sorted by profitability). The site paginates the rest
// behind a "Show more" button that needs a live browser to drive —
// this session doesn't have one connected, so this is 20 of the 50
// requested, not fabricated to fill the gap. Ask to extend it once
// the rest of the list is pasted in or a browser session is available.
//
// Daily profit is NOT copied from the site (their numbers go stale
// the moment you load the page) — it's computed live here from the
// same CoinGecko price + mempool.space difficulty feed the rest of
// the app uses, so this table, the ticker and a customer's earnings
// all agree with each other.
const MINER_CATALOG = [
  { model: 'Antminer Z15 Pro',         algo: 'Equihash', hr: 840,  hrUnit: 'kh/s', power: 2780 },
  { model: 'Antminer Z15K',            algo: 'Equihash', hr: 525,  hrUnit: 'kh/s', power: 2483 },
  { model: 'Antminer X9',              algo: 'RandomX',  hr: 1,    hrUnit: 'Mh/s', power: 2472 },
  { model: 'Antminer Z15',             algo: 'Equihash', hr: 420,  hrUnit: 'kh/s', power: 1510 },
  { model: 'Antminer S23 Hyd 3U',      algo: 'SHA-256',  hr: 1.16, hrUnit: 'Ph/s', power: 11020 },
  { model: 'SealMiner A4 Ultra Hydro', algo: 'SHA-256',  hr: 886,  hrUnit: 'Th/s', power: 8372 },
  { model: 'Antminer S23e Hyd 2U',     algo: 'SHA-256',  hr: 865,  hrUnit: 'Th/s', power: 8650 },
  { model: 'SealMiner DL1 Hydro',      algo: 'Scrypt',   hr: 52.5, hrUnit: 'Gh/s', power: 7823 },
  { model: 'Antminer S23 XP Hyd',      algo: 'SHA-256',  hr: 600,  hrUnit: 'Th/s', power: 5340 },
  { model: 'Antminer S23 Hyd',         algo: 'SHA-256',  hr: 580,  hrUnit: 'Th/s', power: 5510 },
  { model: 'SealMiner A4 Pro Hydro',   algo: 'SHA-256',  hr: 680,  hrUnit: 'Th/s', power: 7412 },
  { model: 'A9++ ZMaster',             algo: 'Equihash', hr: 140,  hrUnit: 'kh/s', power: 1550 },
  { model: 'Antminer Z11',             algo: 'Equihash', hr: 135,  hrUnit: 'kh/s', power: 1418 },
  { model: 'Antminer S21e XP Hyd 3U',  algo: 'SHA-256',  hr: 860,  hrUnit: 'Th/s', power: 11180 },
  { model: 'Antminer S21 XP+ Hyd',     algo: 'SHA-256',  hr: 500,  hrUnit: 'Th/s', power: 5500 },
  { model: 'Antminer L11 Hyd 2U',      algo: 'Scrypt',   hr: 35,   hrUnit: 'Gh/s', power: 5775 },
  { model: 'SealMiner A3 Pro Hydro',   algo: 'SHA-256',  hr: 660,  hrUnit: 'Th/s', power: 8250 },
  { model: 'A9+ ZMaster',              algo: 'Equihash', hr: 120,  hrUnit: 'kh/s', power: 1550 },
  { model: 'SealMiner DL1 Air',        algo: 'Scrypt',   hr: 25,   hrUnit: 'Gh/s', power: 3725 },
  { model: 'Antminer L11 Hyd 6U',      algo: 'Scrypt',   hr: 33,   hrUnit: 'Gh/s', power: 5676 },
];

function catalogHashesPerSec(m) {
  const mult = { 'kh/s': 1e3, 'Mh/s': 1e6, 'Gh/s': 1e9, 'Th/s': 1e12, 'Ph/s': 1e15 }[m.hrUnit] || 1;
  return m.hr * mult;
}

// Human-readable hashrate at its OWN unit — never converted to TH/s,
// since "0.00084 TH/s" for a 840 kh/s Equihash miner is meaningless
// (different algorithms aren't comparable by raw hash count anyway).
function catalogHrDisplay(m) {
  return m.hr + ' ' + m.hrUnit;
}

let profitSortField = 'profit';
let profitSortDir = -1; // most profitable first, matching the source site

function sortProfitBy(field) {
  if (profitSortField === field) profitSortDir *= -1;
  else { profitSortField = field; profitSortDir = field === 'model' ? 1 : -1; }
  renderProfit();
}

function renderProfit() {
  const tb = document.getElementById('profitTbody');
  if (!tb) return;

  const elecInput = document.getElementById('elec');
  const elecRate  = elecInput ? parseFloat(elecInput.value) : NaN;
  const validElec = isFinite(elecRate) && elecRate >= 0;

  const rows = MINER_CATALOG.map(function(m){
    const isSha = m.algo === 'SHA-256';
    // Only SHA-256 gets a live figure: that's the only network we
    // hold both a price AND a difficulty for (CoinGecko + mempool.space).
    // Scrypt/Equihash/RandomX would need their own coin's difficulty,
    // which this app doesn't fetch — showing a number for those would
    // mean guessing it, so they show "—" instead.
    const dailyRevenue = isSha ? estimateGrossUsd(catalogHashesPerSec(m), 1) : null;
    const dailyPowerCost = validElec ? (m.power / 1000) * 24 * elecRate : null;
    const dailyProfit = (dailyRevenue !== null && dailyPowerCost !== null) ? (dailyRevenue - dailyPowerCost) : null;
    const efficiency = isSha ? (m.power / (catalogHashesPerSec(m) / 1e12)) : null; // J/TH
    return { m, dailyRevenue, dailyPowerCost, dailyProfit, efficiency };
  });

  rows.sort(function(a, b){
    let va, vb;
    switch (profitSortField) {
      case 'model':  va = a.m.model.toLowerCase(); vb = b.m.model.toLowerCase(); break;
      case 'algo':   va = a.m.algo;  vb = b.m.algo; break;
      case 'power':  va = a.m.power; vb = b.m.power; break;
      case 'eff':    va = a.efficiency  === null ? Infinity : a.efficiency;  vb = b.efficiency  === null ? Infinity : b.efficiency; break;
      case 'revenue':va = a.dailyRevenue=== null ? -Infinity: a.dailyRevenue;vb = b.dailyRevenue=== null ? -Infinity: b.dailyRevenue; break;
      default:       va = a.dailyProfit === null ? -Infinity : a.dailyProfit; vb = b.dailyProfit === null ? -Infinity : b.dailyProfit;
    }
    if (va < vb) return -1 * profitSortDir;
    if (va > vb) return  1 * profitSortDir;
    return 0;
  });

  tb.innerHTML = rows.map(function(r){
    const m = r.m;
    return '<tr>'
      + '<td style="font-size:11px;font-weight:700;color:var(--cyan)">' + escHtml(m.model) + '</td>'
      + '<td style="font-size:10px;color:var(--mute)">' + escHtml(m.algo) + '</td>'
      + '<td style="font-family:Share Tech Mono,monospace;font-size:11px">' + catalogHrDisplay(m) + '</td>'
      + '<td style="font-family:Share Tech Mono,monospace;font-size:11px">' + m.power.toLocaleString() + 'W</td>'
      + '<td style="font-family:Share Tech Mono,monospace;font-size:11px">' + (r.efficiency !== null ? r.efficiency.toFixed(1) + ' J/TH' : '—') + '</td>'
      + '<td style="font-family:Share Tech Mono,monospace;font-size:11px;color:var(--green)">' + fmtUsd2(r.dailyRevenue) + '</td>'
      + '<td style="font-family:Share Tech Mono,monospace;font-size:11px;color:var(--warn)">' + (r.dailyPowerCost !== null ? '-' + fmtUsd2(r.dailyPowerCost) : '—') + '</td>'
      + '<td style="font-family:Share Tech Mono,monospace;font-size:12px;font-weight:700;' + (r.dailyProfit !== null && r.dailyProfit < 0 ? 'color:var(--red)' : 'color:var(--gold)') + '">' + fmtUsd2(r.dailyProfit) + '</td>'
      + '<td style="font-family:Share Tech Mono,monospace;font-size:11px">' + (r.dailyProfit !== null ? fmtUsd2(r.dailyProfit * 30) : '—') + '</td>'
      + '</tr>';
  }).join('');

  const note = document.getElementById('profitNote');
  if (note) {
    note.textContent = market.ok
      ? 'Live at $' + Math.round(market.btc_usd).toLocaleString() + '/BTC, difficulty ' + (market.difficulty / 1e12).toFixed(1) + 'T'
        + (market.stale ? ' (data ' + market.age_minutes + ' min old)' : '') + '. Scrypt/Equihash/RandomX show "—" — this app only tracks Bitcoin network difficulty.'
      : 'Live market data unavailable right now — profit figures cannot be calculated.';
  }
}


// ── Live market data & mining revenue ───────────────────────
// market.ok stays false until real data actually arrives. Nothing
// here ever substitutes a placeholder price or difficulty: if the
// live figures aren't available, the UI shows a dash instead of a
// number, because these end up on a customer's earnings screen.
let market = { ok: false };

// F2Pool's PPS fee for SHA-256. Revenue quoted to a customer should
// be what the pool actually pays out, not the theoretical gross.
const POOL_FEE_PCT = 2.5;

function fetchMarketData(cb) {
  const base = (typeof API_BASE !== 'undefined') ? API_BASE : '';
  if (!base || base.includes('localhost')) { if (cb) cb(); return; }
  fetch(base + '/api/market')
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(d){
      if (d && d.ok) market = d;
      else market = { ok: false };
      if (cb) cb();
    })
    .catch(function(){ market = { ok: false }; if (cb) cb(); });
}

// SHA-256 (Bitcoin) machines only. A Scrypt/LTC machine's hashrate
// fed into a Bitcoin formula produces a meaningless figure, so those
// are excluded from BTC earnings entirely rather than miscounted.
function isShaMiner(w) {
  const algo = (w.algo || '').toLowerCase();
  if (algo) return algo.indexOf('sha') !== -1;
  // No algo recorded — infer from unit. SHA-256 ASICs are quoted in
  // TH/s or PH/s; Scrypt machines are quoted in MH/s or GH/s.
  const unit = (w.hr_unit || '').toUpperCase();
  return unit.indexOf('TH') === 0 || unit.indexOf('PH') === 0;
}

function hashrateToHashesPerSec(w) {
  const v = Number(w.hashrate) || 0;
  if (v <= 0) return 0;
  const unit = (w.hr_unit || 'TH/s').toUpperCase();
  const mult = unit.indexOf('PH') === 0 ? 1e15
             : unit.indexOf('TH') === 0 ? 1e12
             : unit.indexOf('GH') === 0 ? 1e9
             : unit.indexOf('MH') === 0 ? 1e6
             : 1e12; // default TH/s — the common case for SHA-256
  return v * mult;
}

// Standard mining revenue maths, the same basis a pool calculator uses:
//   expected BTC = hashrate ÷ (network hashrate) × blocks × reward
// expressed via difficulty, since difficulty × 2^32 is the expected
// number of hashes per block found.
function estimateGrossUsd(hashesPerSec, days) {
  if (!market.ok || !hashesPerSec || hashesPerSec <= 0) return null;
  const d = Number(market.difficulty), reward = Number(market.block_reward), price = Number(market.btc_usd);
  if (!isFinite(d) || d <= 0 || !isFinite(reward) || reward <= 0 || !isFinite(price) || price <= 0) return null;
  const btcPerSec = (hashesPerSec * reward) / (d * 4294967296);
  const btc = btcPerSec * 86400 * days;
  return btc * price * (1 - POOL_FEE_PCT / 100);
}

function fmtUsd(v) {
  if (v === null || !isFinite(v)) return '—';
  return '$' + Math.round(v).toLocaleString();
}

// Daily figures are small enough that rounding to whole dollars would
// turn a real $7.40/day into "$7" — or a small account into "$0".
function fmtUsd2(v) {
  if (v === null || !isFinite(v)) return '—';
  if (Math.abs(v) >= 1000) return '$' + Math.round(v).toLocaleString();
  return '$' + v.toFixed(2);
}

// ── Cumulative earnings ─────────────────────────────────────
// Read-only. The running total is accrued by the BACKEND every 10
// minutes from the machines that are actually hashing; the browser
// never adds to it. That matters: if the total were computed on page
// view, two people opening the portal would double it, and nothing
// would accrue while nobody was looking.
let earningsSummary = null;

function fetchEarnings(cb) {
  const base = (typeof API_BASE !== 'undefined') ? API_BASE : '';
  if (!base || base.includes('localhost') || !currentUser || !currentUser.id) { if (cb) cb(); return; }
  const token = localStorage.getItem('ekl_token') || '';
  fetch(base + '/api/earnings/summary/' + encodeURIComponent(currentUser.id),
        { headers: { 'Authorization': 'Bearer ' + token } })
    .then(function(r){ return r && r.ok ? r.json() : null; })
    .then(function(d){
      earningsSummary = (d && d.ok) ? d : null;
      renderTotalEarned();
      if (cb) cb();
    })
    .catch(function(){ earningsSummary = null; renderTotalEarned(); if (cb) cb(); });
}

function renderTotalEarned() {
  const el  = document.getElementById('pTotalEarned');
  const sub = document.getElementById('pTotalEarnedSub');
  if (!el) return;
  if (!earningsSummary) {
    el.textContent = '—';
    if (sub) sub.textContent = 'not available';
    return;
  }
  // Net of hosting — the number that means something to a customer.
  const net = Number(earningsSummary.total_gross_usd) - Number(earningsSummary.total_hosting_usd);
  el.textContent = isFinite(net) ? fmtUsd2(net) : '—';
  if (sub) {
    const days = Number(earningsSummary.days_recorded) || 0;
    sub.textContent = earningsSummary.since
      ? 'since ' + earningsSummary.since + ' (' + days + ' day' + (days === 1 ? '' : 's') + ')'
      : 'since start';
  }
}

function renderPortal() {
  try { renderDash(); } catch(e) {}
  if (!currentUser) return;

  const mine   = workers.filter(function(w){ return w.cid === currentUser.id; });
  const online = mine.filter(function(w){ return effectiveStatus(w) === 'online'; });
  // Machines can report in GH/s or TH/s — normalize to TH/s for one
  // combined total instead of nonsensically adding mixed units together
  const totalHrTH = mine.reduce(function(sum, w){
    const hr = w.hashrate || 0;
    return sum + (w.hr_unit === 'GH/s' ? hr / 1000 : hr);
  }, 0);
  const custRecord = customers.find(function(c){ return c.id === currentUser.id; });

  // Top summary cards — previously static placeholders that never
  // actually reflected the real assigned machines below them
  const avEl = document.getElementById('portalAv');
  if (avEl) avEl.textContent = (currentUser.name || '?').split(' ').map(function(w){return w[0];}).join('').slice(0,2).toUpperCase();
  const greetEl = document.getElementById('portalGreeting');
  if (greetEl) greetEl.textContent = 'Welcome, ' + (currentUser.name || '').split(' ')[0] + '!';
  const pTotal = document.getElementById('pTotal');   if (pTotal)  pTotal.textContent  = mine.length;
  const pOnline = document.getElementById('pOnline'); if (pOnline) pOnline.textContent = online.length;
  const pHR = document.getElementById('pHR');         if (pHR)     pHR.textContent     = totalHrTH.toFixed(1);

  // ── Earnings ────────────────────────────────────────────
  // Real revenue from live BTC price + live network difficulty.
  // Only machines that are actually hashing RIGHT NOW earn anything,
  // and only SHA-256 machines earn BTC — a Scrypt (LTC) machine's
  // hashrate must never be fed into a Bitcoin revenue formula, or
  // the figure comes out wildly wrong.
  const shaHashesPerSec = online.reduce(function(sum, w){
    if (!isShaMiner(w)) return sum;
    return sum + hashrateToHashesPerSec(w);
  }, 0);
  const nonShaOnline = online.filter(function(w){ return !isShaMiner(w); }).length;

  // PER DAY, not per month. This is the run-rate at the hashrate the
  // machines are producing right now — what they'd earn over 24h if
  // they kept running exactly as they are.
  const grossDay = estimateGrossUsd(shaHashesPerSec, 1);
  // Hosting is quoted monthly per machine, so the daily share is the
  // monthly rate ÷ 30 — matching how the accrual service bills it.
  const feeDay   = (custRecord && custRecord.rate) ? (custRecord.rate * mine.length) / 30 : null;

  const pGross = document.getElementById('pGross');
  const pFee   = document.getElementById('pFee');
  const pNet   = document.getElementById('pNet');
  // A dash — never a zero or a guess — whenever the live market data
  // isn't available or the hosting rate hasn't been set. These are
  // real money figures; a blank is honest, a wrong number is not.
  if (pGross) pGross.textContent = grossDay === null ? '—' : fmtUsd2(grossDay);
  if (pFee)   pFee.textContent   = feeDay   === null ? '—' : fmtUsd2(feeDay);
  if (pNet)   pNet.textContent   = (grossDay === null || feeDay === null) ? '—' : fmtUsd2(grossDay - feeDay);

  // Cumulative total — read from the backend, never computed here.
  // See fetchEarnings() for why.
  renderTotalEarned();

  const note = document.getElementById('pEarnNote');
  if (note) {
    if (!market.ok) {
      note.textContent = 'Live market data unavailable — earnings cannot be calculated right now.';
    } else {
      note.textContent = 'Daily run-rate at $' + Math.round(market.btc_usd).toLocaleString()
        + '/BTC, difficulty ' + (market.difficulty / 1e12).toFixed(1) + 'T'
        + (market.stale ? ' (data ' + market.age_minutes + ' min old)' : '')
        + (nonShaOnline ? ' · excludes ' + nonShaOnline + ' non-SHA-256 machine(s)' : '')
        + ' · Total Earned accrues every 10 min from machines actually running; estimate, not pool payout.';
    }
  }

  const badge = document.getElementById('portalOnlineBadge');
  if (badge) badge.textContent = online.length + ' Online';

  const tb = document.getElementById('portalTable');
  if (!tb) return;

  if (mine.length === 0) {
    tb.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:30px;color:var(--mute)">No machines assigned to your account yet.<br><span style="font-size:11px">Contact your farm operator to have machines linked to you.</span></td></tr>';
    return;
  }

  tb.innerHTML = mine.map(function(w){
    const eff = effectiveStatus(w);
    const sb  = w.disabled ? 'bor' : eff === 'online' ? 'bgn' : 'brn';
    return '<tr>'
      + '<td><span class="sdot ' + sdot(w) + '"></span></td>'
      + '<td style="font-family:Share Tech Mono,monospace;font-size:12px;color:var(--cyan);font-weight:700">' + (w.name || w.ip) + '</td>'
      + '<td style="font-size:11px">' + cleanBrandModel(w.brand) + ' ' + cleanBrandModel(w.model) + '</td>'
      + '<td style="color:var(--green);font-family:Share Tech Mono,monospace;font-size:11px">' + (eff === 'online' ? (w.hr_display || '—') : '—') + '</td>'
      + '<td style="font-family:Share Tech Mono,monospace;font-size:11px">' + (eff === 'online' && w.temp > 0 ? w.temp + '°C' : '—') + '</td>'
      + '<td style="font-family:Share Tech Mono,monospace;font-size:11px">' + (eff === 'online' && w.fan > 0 ? w.fan : '—') + '</td>'
      + '<td style="font-size:10px;color:var(--mute)">' + (w.pool || '—') + '</td>'
      + '<td><span class="badge ' + sb + '">' + (w.disabled ? 'REPAIR' : eff.toUpperCase()) + '</span></td>'
      + '<td><button class="abtn" onclick="openCtrl(\'' + w.id + '\')">Manage</button></td>'
      + '</tr>';
  }).join('');
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
  const md = document.getElementById('ctrlModel');if (md) md.textContent = cleanBrandModel(w.brand) + ' ' + cleanBrandModel(w.model);
  const wi = document.getElementById('ctrlWorkerId');
  if (wi) {
    var parts = [];
    if (w.worker_id && w.worker_id !== '—') parts.push('Worker: ' + w.worker_id);
    parts.push('S/N: ' + (w.serial || '<span style="color:var(--mute)">not set</span>'));
    parts.push('MAC: ' + (w.mac || '<span style="color:var(--mute)">not set</span>'));
    wi.innerHTML = parts.join('<br>')
      + '<button class="abtn" style="margin-top:6px" onclick="editSerialAndMac(\'' + w.id + '\');refreshCtrl();">&#x270E; Edit S/N &amp; MAC</button>';
  }
  el.style.display = 'flex';

  // Customer accounts get history, web login and diagnostics only —
  // no delete from fleet. Ownership of the machine itself is still
  // enforced server-side on every request; this is just keeping their
  // UI free of a button they can't use.
  const dangerSec = document.getElementById('ctrlDangerSec');
  if (dangerSec) dangerSec.style.display = isCustomer ? 'none' : '';

  // Disable / Enable — one or the other, never both, so the panel
  // always shows the action that applies to this machine right now.
  const maintSec = document.getElementById('ctrlMaintSec');
  if (maintSec) maintSec.style.display = isCustomer ? 'none' : '';
  const disBtn  = document.getElementById('ctrlDisableBtn');
  const enBtn   = document.getElementById('ctrlEnableBtn');
  const disNote = document.getElementById('ctrlDisabledNote');
  if (disBtn) disBtn.style.display = w.disabled ? 'none' : '';
  if (enBtn)  enBtn.style.display  = w.disabled ? '' : 'none';
  if (disNote) {
    if (w.disabled) {
      const since = w.disabled_at ? new Date(w.disabled_at).toLocaleString() : 'unknown date';
      disNote.innerHTML = '<b>Out of service.</b> ' + escHtml(w.disabled_reason || 'No reason recorded')
        + '<br><span style="color:var(--mute)">Since ' + escHtml(since) + '</span>';
      disNote.style.display = '';
    } else {
      disNote.style.display = 'none';
    }
  }

  // Default to 7 days — enough to see a real trend without waiting on
  // a slow 30-day fetch every time the panel opens.
  loadMinerHistory(wid, 168);
}
function closeCtrl() { const el = document.getElementById('ctrlPanel'); if (el) el.style.display = 'none'; activeWid = null; histState.wid = null; }
function refreshCtrl() { if (activeWid) openCtrl(activeWid); }

// ── Quick assign ──────────────────────────────────────────
function quickAssign(cid) {
  // Previously guarded behind checking for a "assignSheet" overlay
  // element that doesn't exist anywhere in the page — that guard
  // always failed silently, so this function never did anything at
  // all when the button was clicked. The real Assign panel lives
  // directly on the Customers page itself, no overlay needed.
  const sel = document.getElementById('assignSel');
  if (sel) sel.value = cid;
  renderAssign();
  const panel = document.getElementById('assignPanel');
  if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
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

  // A miner can only belong to one customer — remove it from any
  // OTHER customer's list before assigning it here
  customers.forEach(x => { if (x.id !== cid) x.miners = x.miners.filter(id => !pendingAssign.includes(id)); });

  const previouslyAssigned = c.miners || [];
  c.miners = [...pendingAssign];

  // Keep each worker's OWN cid field in sync — this is what the
  // Workers page's Customer column and the customer portal actually
  // read. Without this, an assignment made here would only ever
  // update the customer's own miners[] list and never show up
  // anywhere else in the app.
  pendingAssign.forEach(function(wid){
    const w = workers.find(function(x){ return x.id === wid; });
    if (w) w.cid = cid;
  });
  previouslyAssigned.forEach(function(wid){
    if (pendingAssign.includes(wid)) return; // still assigned, leave it
    const w = workers.find(function(x){ return x.id === wid; });
    if (w && w.cid === cid) w.cid = ''; // unchecked this time — clear it
  });

  saveFleet();
  saveFleetToBackend();
  toast('✓ ' + c.name + ': ' + pendingAssign.length + ' miners assigned', 'var(--green)');
  renderCustomers(); renderWorkers(); renderDash();
}

// ── Overlay / sheet helpers ───────────────────────────────
function openOverlay(id) { const el = document.getElementById(id); if (el) el.classList.add('show'); }
function closeOverlay()   { document.querySelectorAll('.overlay.show').forEach(el => el.classList.remove('show')); }
function openSheet(id)    { const el = document.getElementById(id); if (el) el.classList.add('show'); }
function closeSheet(id)   { const el = document.getElementById(id); if (el) el.classList.remove('show'); }

// ── Toast notification ────────────────────────────────────
// (stub toast removed — full version defined later)

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
// (stub fetchAgents removed — full version defined later)

// (stub updateAgentUI removed — full version defined later)

// ── Trigger scan from agents page ────────────────────────
function triggerScan(farmId) {
  const agent = agents.find(a => a.id === farmId);
  if (!agent) return;
  nav('agents', null);
  setRemoteAccessTab('scanner');
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
  nav('agents', null);
  setRemoteAccessTab('scanner');
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

// ── Sensor MAC config (per farm) ─────────────────────────
function getSensorMacs(farmId){
  try { return JSON.parse(localStorage.getItem('sensor_macs_' + farmId) || '[]'); } catch { return []; }
}
function getSensorIpRange(farmId){
  return localStorage.getItem('sensor_iprange_' + farmId) || '';
}
function setSensorIpRange(farmId, range){
  if (range) localStorage.setItem('sensor_iprange_' + farmId, range);
  else localStorage.removeItem('sensor_iprange_' + farmId);
}
function setSensorMacs(farmId, macs){
  localStorage.setItem('sensor_macs_' + farmId, JSON.stringify(macs));
  const token = localStorage.getItem('ekl_token');
  if (token && API_BASE && !API_BASE.includes('localhost')) {
    fetch(API_BASE + '/api/sensors/agent-config', {
      method: 'POST',
      headers: {'Content-Type':'application/json','Authorization':'Bearer '+token},
      body: JSON.stringify({ farm_id: farmId, macs: macs })
    }).catch(function(){});
  }
}

function renderSensorEntryGrid() {
  const el = document.getElementById('sensorMacGrid');
  if (!el) return;
  const farms = agents.length > 0 ? agents : [{id:'ghummadh',name:'Ghummadh'},{id:'alhayer',name:'Al Hayer'},{id:'hydro',name:'Hydro'}];

  el.innerHTML = farms.map(function(f) {
    const r = getSensorReading(f.id) || {};
    const macs = getSensorMacs(f.id);
    const online = agents.find(function(a){ return a.id === f.id; });
    return '<div style="background:var(--s2);border:1px solid var(--b1);border-radius:8px;padding:12px">'
      + '<div style="display:flex;align-items:center;gap:6px;margin-bottom:10px">'
      +   '<span class="sdot ' + (online && online.online ? 'on' : 'off') + '"></span>'
      +   '<span style="font-family:Exo 2,sans-serif;font-weight:700;font-size:12px;color:var(--txt)">' + f.name + '</span>'
      +   (r.updated ? '<span style="font-size:9px;color:var(--mute);font-weight:400;margin-left:auto">' + new Date(r.updated).toLocaleTimeString() + '</span>' : '')
      + '</div>'

      // Live readings display
      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;text-align:center">'
      +   '<div><div style="font-family:Share Tech Mono,monospace;font-size:26px;color:var(--warn)">' + (r.temp != null ? r.temp : '—') + '</div>'
      +   '<div style="font-size:9px;color:var(--mute);text-transform:uppercase;letter-spacing:1px">°C Temp</div></div>'
      +   '<div><div style="font-family:Share Tech Mono,monospace;font-size:26px;color:var(--cyan)">' + (r.humidity != null ? r.humidity : '—') + '</div>'
      +   '<div style="font-size:9px;color:var(--mute);text-transform:uppercase;letter-spacing:1px">% Humidity</div></div>'
      + '</div>'

      // IP Range input
      + '<div style="font-size:9px;color:var(--mute);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">IP Range <span style="text-transform:none;color:var(--cyan)">(optional — scans this range)</span></div>'
      + '<input id="iprange_' + f.id + '" placeholder="192.168.13.1-255" value="' + (getSensorIpRange(f.id)||'') + '" style="width:100%;background:var(--bg);border:1px solid var(--b1);border-radius:4px;padding:6px 8px;color:var(--txt);font-family:Share Tech Mono,monospace;font-size:11px;outline:none;margin-bottom:8px">'

      // MAC address input
      + '<div style="font-size:9px;color:var(--mute);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Sensor MAC Address' + (macs.length > 1 ? 'es' : '') + '</div>'
      + '<textarea id="mac_' + f.id + '" rows="2" placeholder="a4:cf:12:ab:cd:ef" style="width:100%;background:var(--bg);border:1px solid var(--b1);border-radius:4px;padding:6px 8px;color:var(--txt);font-family:Share Tech Mono,monospace;font-size:11px;outline:none;resize:vertical;margin-bottom:8px">' + macs.join('\n') + '</textarea>'

      + '<div style="display:flex;gap:6px">'
      +   '<button class="btn btn-sm btn-g sensor-save-btn" data-fid="' + f.id + '" data-fname="' + f.name + '">&#x1F4BE; Save</button>'
      +   '<button class="btn btn-sm sensor-scan-btn" data-fid="' + f.id + '" data-fname="' + f.name + '">&#x1F50D; Scan Now</button>'
      + '</div>'
      + '</div>';
  }).join('');

  el.querySelectorAll('.sensor-save-btn').forEach(function(b){
    b.addEventListener('click', function(){ saveSensorMacs(this.dataset.fid, this.dataset.fname); });
  });
  el.querySelectorAll('.sensor-scan-btn').forEach(function(b){
    b.addEventListener('click', function(){ scanSensorNow(this.dataset.fid, this.dataset.fname); });
  });
}

function saveSensorMacs(farmId, farmName){
  const raw = document.getElementById('mac_' + farmId)?.value || '';
  const macs = raw.split(/[,\n]+/).map(function(s){ return s.trim(); }).filter(Boolean);
  setSensorMacs(farmId, macs);
  const range = document.getElementById('iprange_' + farmId)?.value.trim() || '';
  setSensorIpRange(farmId, range);
  toast('✓ Sensor config saved for ' + farmName, 'var(--green)');
}

function scanSensorNow(farmId, farmName){
  const macRaw = document.getElementById('mac_' + farmId)?.value || '';
  const macs   = macRaw.split(/[,\n]+/).map(function(s){ return s.trim(); }).filter(Boolean);
  const range  = document.getElementById('iprange_' + farmId)?.value.trim() || '';

  if (macs.length === 0 && !range) { toast('Enter a MAC address, an IP range, or both', 'var(--warn)'); return; }
  saveSensorMacs(farmId, farmName);

  const token = localStorage.getItem('ekl_token');
  if (!token) { toast('Not logged in', 'var(--red)'); return; }

  const body = { farm_id: farmId };
  if (macs.length > 0) body.macs = macs;
  if (range) {
    const ips = expandIPRange(range);
    if (ips.length === 0) { toast('Invalid IP range format', 'var(--red)'); return; }
    body.ips = ips;
  }

  const msg = (body.ips && body.macs) ? 'Scanning ' + farmName + ' and matching MAC...'
            : body.macs ? 'Resolving MAC for ' + farmName + '...'
            : 'Scanning ' + farmName + ' for sensors...';
  toast(msg, 'var(--cyan)');

  fetch(API_BASE + '/api/sensors/discover', {
    method: 'POST',
    headers: {'Content-Type':'application/json','Authorization':'Bearer '+token},
    body: JSON.stringify(body)
  })
  .then(function(r){ return r.json(); })
  .then(function(d){
    if (d.ok) {
      toast('✓ Sent to agent — reading in ~15-30s', 'var(--green)');
      setTimeout(function(){ fetchSensorFromBackend(farmId); }, 20000);
      setTimeout(function(){ fetchSensorFromBackend(farmId); }, 60000);
      setTimeout(function(){ fetchSensorFromBackend(farmId); renderSensorEntryGrid(); }, 120000);
    } else {
      toast('✗ ' + (d.error || 'Failed'), 'var(--red)');
    }
  })
  .catch(function(e){ toast('✗ ' + e.message, 'var(--red)'); });
}

// ── Fleet stat for settings page ─────────────────────────
function updateFleetStat() {
  const el = document.getElementById('fleetStoreStat');
  if (!el) return;
  el.textContent = workers.length + ' workers · ' + customers.length + ' customers';
  const token = localStorage.getItem('ekl_token');
  if (token 