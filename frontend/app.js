
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
// Low-hashing benchmark (used by the very first render, so declared up here —
// further down it threw "Cannot access '_hashBench' before initialization"
// and the Workers list failed to draw on page load).
const LOW_HASH_PCT = 15, LOW_HASH_MIN_COHORT = 3;
let _hashBench = new Map();
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
  try{ renderDash(); }catch(e){ console.error('renderDash:',e); }   // includes the power panel
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
  computeHashBench();   // per-model medians, used for the low-hash colour and filter

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
    const running = isRunning(w);
    const hh   = running ? hashHealth(w) : null;
    const low  = !!(hh && hh.low);
    const st   = w.disabled ? 'REPAIR' : agentDown ? 'AGENT OFFLINE' : low ? 'LOW HASH' : eSt.toUpperCase();
    const sb   = w.disabled ? 'bor' : low ? 'bwn' : eSt === 'online' ? 'bgn' : eSt === 'warn' ? 'bwn'
               : eSt === 'sleeping' ? 'bpp' : eSt === 'rebooting' ? 'bc' : 'brn';
    // The whole row is coloured by state so it can be picked out at a
    // glance: green = online, yellow = low hashing, red = offline,
    // purple = sleeping, orange stripes = in repair. Done with classes
    // (CSS in index.html) so the row banding doesn't fight inline styles.
    const rowClass = ' class="' + (w.disabled ? 'wdis' : low ? 'wlow' : running ? 'won'
                   : eSt === 'sleeping' ? 'wslp' : 'woff') + '"';
    const hrTitle = hh ? Math.round(hh.pct) + '% of the median for this model (' + (Math.round(hh.median * 1000) / 1000) + ' TH/s)'
                       : 'Not enough running machines of this model to compare';
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
      + '<td title="' + (running ? hrTitle : '') + '" style="color:' + (low ? 'var(--warn)' : 'var(--green)') + ';font-family:Share Tech Mono,monospace;font-size:11px">'
      +   (running ? hrDisplay(w) + (low ? '<div style="font-size:9px">' + Math.round(hh.pct) + '% of model</div>' : '') : '<span style="color:var(--mute)">—</span>') + '</td>'
      + '<td style="' + tc + ';font-family:Share Tech Mono,monospace;font-size:11px">' + (running && w.temp > 0 ? w.temp + '\u00b0C' : '—') + '</td>'
      + '<td style="font-family:Share Tech Mono,monospace;font-size:11px">' + (running && w.fan > 0 ? w.fan : '—') + '</td>'
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
  // Same definitions as the filters the chips open, so a chip's number
  // always equals the rows it shows.
  const on  = scope.filter(function(w){ return matchesWorkerFilter(w, 'online'); }).length;
  const lo  = scope.filter(function(w){ return matchesWorkerFilter(w, 'low'); }).length;
  const off = scope.filter(function(w){ return matchesWorkerFilter(w, 'offline'); }).length;
  const dis = scope.filter(function(w){ return w.disabled; }).length;
  const eOn = document.getElementById('wOnlineBadge');  if (eOn) eOn.textContent = on;
  const eLo = document.getElementById('wLowBadge');     if (eLo) { eLo.textContent = lo; eLo.style.display = lo ? '' : 'none'; }
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
  // IP ranges = what the agent polls continuously: the same editor as Farms
  el.querySelectorAll('.cfg-btn').forEach(function(b){ b.addEventListener('click',function(){
    const aid = this.dataset.aid;
    if (farmById(aid)) return openRanges(aid);
    const self = this;
    authFetch('/api/farms').then(function(d){
      if (d && d.ok) { farmsState = { farms: d.farms || [], pending: d.pending || [], poll_sec: d.poll_sec || farmsState.poll_sec }; if (farmById(aid)) return openRanges(aid); }
      openAgentConfig(aid, self.dataset.name, self.dataset.subnet);
    });
  }); });
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

  // Auto-restart for this machine (staff only)
  const arSec = document.getElementById('ctrlArSec');
  if (arSec) arSec.style.display = isCustomer ? 'none' : '';
  if (!isCustomer) loadMachineAutoRestart(wid);

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
// Ranges typed here are for a one-off SCAN only (kept on this device to
// fill the scanner). They used to be saved to the server as well, and
// since agents started polling the server's ranges that turned a scan of
// one farm's networks into another farm's permanent polling ranges
// (Ghummadh ended up "polling" Alhayer's 192.168.44/70). Polling ranges
// are set only in Remote Access → Farms → IP ranges.
function setAgentSubnets(farmId, subnets) {
  localStorage.setItem('agent_subnets_' + farmId, JSON.stringify(subnets));
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
      + '<div style="font-size:9px;color:var(--mute);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">IP range <span style="text-transform:none;color:var(--dim)">(optional)</span></div>'
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
  if (token && API_BASE && !API_BASE.includes('localhost')) {
    fetch(API_BASE + '/api/fleet/status', {headers:{'Authorization':'Bearer '+token}})
      .then(r => r.json()).then(d => {
        if (!d.ok) return;
        if (d.storage === 'postgresql') {
          el.innerHTML += ' · <span style="color:var(--green)">✓ database</span>';
        } else {
          // File storage used to be shown with a green tick like the
          // database, which made a serious problem look like a healthy
          // state. On a hosted platform this file is wiped on every
          // redeploy, taking customer portal passwords and team logins
          // with it — the exact cause of "credentials erased after an
          // update". It needs to be alarming, not reassuring.
          el.innerHTML += ' · <span style="color:var(--red)">⚠ NO DATABASE — temporary storage</span>'
            + '<div style="color:var(--red);font-size:10px;margin-top:6px;line-height:1.5">'
            + 'Customer passwords and team logins are being stored in a temporary file and <strong>will be erased the next time the software is updated</strong>.<br>'
            + 'Fix: set <span style="font-family:monospace">DATABASE_URL</span> on the server to your Postgres database, then restart it.</div>';
        }
      }).catch(() => {});
  }
}

// ── CSV helpers ────────────────────────────────────────────
const CSV_COLUMNS = [
  'id','name','worker_id','model','brand','algo','ip','mac','serial',
  'hashrate','hr_unit','hr_display','temp','fan','power','status',
  'pool','pool_user','uptime','farm','farm_id','cid','disabled',
  'disabled_reason','disabled_at','led','firmware','accepted',
  'rejected','hw_errors','source','added_at'
];

function csvEscape(val){
  if (val === null || val === undefined) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function csvParseLine(line){
  const out = []; let cur = ''; let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i+1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { cur += c; }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

// ── Export fleet as CSV ────────────────────────────────────
// ── Find & merge duplicate miners ───────────────────────────
// For machines that were physically moved BEFORE this de-duplication
// logic existed, or whose IP changed (a reboot, a power outage — every
// machine on a switch can come back with a new DHCP lease at once) and
// were never matched back to their old record because that record's
// MAC/Serial were never captured in the first place — finds any group
// of workers sharing the same MAC, Serial, OR pool Worker ID and merges
// them into one record, keeping whichever is currently online (or most
// recently updated if none are), and carrying over any customer
// assignment / manual edits from either.
//
// The pool Worker ID (the wallet.worker-name string configured ON the
// miner) is included as a grouping key because it's the one identifier
// that survives a reboot and a new IP even when MAC/Serial were never
// successfully read — exactly the case after a power-cut reboots an
// entire farm at once. It's excluded when it's the placeholder "—" so
// a farm with several not-yet-configured machines doesn't get them all
// grouped together as if they were one duplicated machine.
function findDuplicateMiners(){
  const groups = {};
  workers.forEach(function(w){
    [w.mac, w.serial, (w.worker_id && w.worker_id !== '—' ? 'wid:' + w.worker_id : null)].filter(Boolean).forEach(function(key){
      if(!groups[key]) groups[key] = [];
      if(groups[key].indexOf(w) === -1) groups[key].push(w);
    });
  });
  const dupGroups = [];
  const seen = new Set();
  Object.values(groups).forEach(function(group){
    if(group.length < 2) return;
    // Two records of ONE machine can't both be live at once. If several
    // records in a group are online at DIFFERENT addresses right now,
    // these are different machines that happen to report the same
    // MAC/Serial — some firmware ships a batch with an identical value,
    // or prints a constant one in its boot log. Merging them would
    // delete real machines, so leave them alone.
    var liveIps = {};
    group.forEach(function(w){
      if (effectiveStatus(w) === 'online' && w.ip) liveIps[w.ip] = true;
    });
    if (Object.keys(liveIps).length > 1) {
      console.warn('[MERGE] Skipping ' + group.length + ' machines sharing an ID but online at different IPs: '
        + Object.keys(liveIps).join(', '));
      return;
    }
    const ids = group.map(function(w){return w.id;}).sort().join(',');
    if(seen.has(ids)) return;
    seen.add(ids);
    dupGroups.push(group);
  });
  return dupGroups;
}

function mergeDuplicateGroup(group){
  // Prefer the one currently online; otherwise the most recently added/updated
  const winner = group.slice().sort(function(a,b){
    const aOn = effectiveStatus(a) === 'online' ? 1 : 0;
    const bOn = effectiveStatus(b) === 'online' ? 1 : 0;
    if (aOn !== bOn) return bOn - aOn;
    return new Date(b.added_at||0) - new Date(a.added_at||0);
  })[0];

  // Carry over anything useful from the losing record(s) that the
  // winner is missing — customer assignment, manual MAC/Serial, notes
  group.forEach(function(w){
    if(w === winner) return;
    if(!winner.cid && w.cid) winner.cid = w.cid;
    if(!winner.mac && w.mac) winner.mac = w.mac;
    if(!winner.serial && w.serial) winner.serial = w.serial;
    if((!winner.worker_id || winner.worker_id === '—') && w.worker_id && w.worker_id !== '—') winner.worker_id = w.worker_id;
    if(w.mac_manual) winner.mac_manual = true;
    if(w.serial_manual) winner.serial_manual = true;
  });

  const losingIds = group.filter(function(w){ return w !== winner; }).map(function(w){ return w.id; });
  workers = workers.filter(function(w){ return losingIds.indexOf(w.id) === -1; });
  return { winner: winner, removed: losingIds.length, removedIds: losingIds };
}

function findAndMergeDuplicates(){
  const dupGroups = findDuplicateMiners();
  if(dupGroups.length === 0){
    toast('No duplicate miners found \u2014 fleet is clean', 'var(--green)');
    return;
  }
  const totalDupes = dupGroups.reduce(function(sum,g){ return sum + g.length - 1; }, 0);
  const preview = dupGroups.slice(0,5).map(function(g){
    return '\u2022 ' + (g[0].name||g[0].ip) + ' (' + g.length + ' copies across: ' + g.map(function(w){return w.farm||w.ip;}).join(', ') + ')';
  }).join('\n');
  const more = dupGroups.length > 5 ? '\n...and ' + (dupGroups.length-5) + ' more' : '';

  if(!confirm('Found ' + dupGroups.length + ' duplicate miner(s), ' + totalDupes + ' extra record(s) to remove:\n\n' + preview + more + '\n\nMerge now? The most recently active copy of each is kept.')) return;

  let totalRemoved = 0;
  let allRemovedIds = [];
  dupGroups.forEach(function(g){
    const result = mergeDuplicateGroup(g);
    totalRemoved += result.removed;
    allRemovedIds = allRemovedIds.concat(result.removedIds);
  });

  _fleetHash = ''; _workersHash = '';
  saveFleet();
  saveFleetToBackend();

  // The splice above only removes these from THIS device's local copy.
  // Without an explicit delete, the backend's upsert-only /api/fleet/save
  // never learns these records are gone \u2014 they stay in the database,
  // and every other device (and this one, on its next load) pulls them
  // straight back in, since loadFleetFromBackend is deliberately
  // additive-only. Deleting each one server-side records a tombstone,
  // so the removal actually propagates everywhere via pruneDeletedLocally.
  const token = localStorage.getItem('ekl_token');
  if (token && API_BASE && !API_BASE.includes('localhost')) {
    allRemovedIds.forEach(function(id){
      fetch(API_BASE + '/api/fleet/worker/' + encodeURIComponent(id), {
        method: 'DELETE',
        headers: {'Authorization':'Bearer '+token}
      }).catch(function(){});
    });
  }

  renderWorkers(); renderDash();
  toast('\u2713 Merged ' + dupGroups.length + ' duplicate(s) \u2014 removed ' + totalRemoved + ' extra record(s)', 'var(--green)');
}

function clearAllFleetData(){
  if(!confirm('Clear ALL workers and customers? This also deletes them from the server — this cannot be undone.')) return;
  workers = [];
  customers = [];
  saveFleet();
  // Also clear on the backend, or a page refresh will merge the old data straight back in
  const token = localStorage.getItem('ekl_token');
  if (token && API_BASE && !API_BASE.includes('localhost')) {
    fetch(API_BASE + '/api/fleet/save', {
      method: 'POST',
      headers: {'Content-Type':'application/json','Authorization':'Bearer '+token},
      body: JSON.stringify({ workers: [], customers: [], clearAll: true })
    }).catch(function(){});
  }
  renderAll();
  toast('Fleet cleared — local and server', 'var(--red)');
}

function exportFleet() {
  if (workers.length === 0) { toast('No workers to export', 'var(--warn)'); return; }
  const rows = [CSV_COLUMNS.join(',')];
  workers.forEach(function(w){
    rows.push(CSV_COLUMNS.map(function(col){ return csvEscape(w[col]); }).join(','));
  });
  const csv = rows.join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], {type:'text/csv;charset=utf-8;'}));
  a.download = 'ekalavya-fleet-' + new Date().toISOString().slice(0,10) + '.csv';
  a.click();
  toast('✓ Fleet exported (' + workers.length + ' workers)', 'var(--green)');
}

// ── Import fleet from CSV ──────────────────────────────────
function importFleet(e) {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = function(ev){
    try {
      const text = ev.target.result;
      const lines = text.split(/\r?\n/).filter(function(l){ return l.trim() !== ''; });
      if (lines.length < 2) throw new Error('CSV has no data rows');

      const header = csvParseLine(lines[0]).map(function(h){ return h.trim(); });
      const imported = [];
      for (let i = 1; i < lines.length; i++) {
        const vals = csvParseLine(lines[i]);
        const row = {};
        header.forEach(function(col, idx){ row[col] = vals[idx] !== undefined ? vals[idx] : ''; });
        // Restore correct types
        ['hashrate','temp','fan','power','accepted','rejected','hw_errors'].forEach(function(n){
          row[n] = row[n] !== '' ? parseFloat(row[n]) : 0;
        });
        row.disabled = row.disabled === 'true' || row.disabled === true;
        if (!row.id || !row.ip) continue; // skip malformed rows
        imported.push(row);
      }
      if (imported.length === 0) throw new Error('No valid worker rows found');
      if (!confirm('Import ' + imported.length + ' workers from CSV? This replaces your current fleet.')) return;

      workers = imported;
      saveFleet(); saveFleetToBackend(); renderAll();
      toast('✓ Imported ' + workers.length + ' workers from CSV', 'var(--green)');
    } catch(err) {
      alert('Import failed: ' + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

// ── Add customer ──────────────────────────────────────────
function togglePortalFields() { const el = document.getElementById('portalFields'); if (el) el.style.display = document.getElementById('cPortalToggle')?.checked ? 'block' : 'none'; }
function addCustomer() {
  const n = document.getElementById('cName')?.value.trim();
  if (!n) { alert('Customer name required'); return; }
  // Previously gated behind a "cPortalToggle" checkbox that doesn't
  // exist anywhere in the page — that check always silently failed,
  // so email/password were discarded no matter what was typed here.
  // The form always shows these fields, so just use them directly.
  const email = document.getElementById('cEmail')?.value.trim() || '';
  const pass  = document.getElementById('cPass')?.value || '';
  const hasPortal = !!email;
  if (hasPortal && !pass) { alert('Set a temporary password for portal access'); return; }
  const c = { id:'cust-'+Date.now(), name:n, email, password: pass, country:document.getElementById('cCountry')?.value||'', notes:'', plan:'Standard', rate:0, miners:[], active:true, portal:hasPortal };
  customers.push(c);
  closeSheet('addCustSheet');
  ['cName','cEmail','cPass','cCountry'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  saveFleet(); saveFleetToBackend(); renderAll();
  toast(hasPortal ? '✓ Customer added with portal access' : '✓ Customer added', 'var(--green)');
}

// ── Edit Customer — portal email/password/details ──────────
function openEditCustomer(cid) {
  const c = customers.find(x => x.id === cid);
  if (!c) return;
  document.getElementById('ecId').value = cid;
  document.getElementById('ecName').value = c.name || '';
  document.getElementById('ecEmail').value = c.email || '';
  document.getElementById('ecPass').value = ''; // never pre-filled — blank means "keep current"
  document.getElementById('ecPass').placeholder = c.has_password ? 'Leave blank to keep current password' : 'Set a password for portal access';
  document.getElementById('ecCountry').value = c.country || '';
  openSheet('editCustSheet');
}

function saveEditCustomer() {
  const cid = document.getElementById('ecId').value;
  const c = customers.find(x => x.id === cid);
  if (!c) return;
  const n = document.getElementById('ecName')?.value.trim();
  if (!n) { alert('Customer name required'); return; }
  const email = document.getElementById('ecEmail')?.value.trim() || '';
  const newPass = document.getElementById('ecPass')?.value || '';

  c.name = n;
  c.email = email;
  c.country = document.getElementById('ecCountry')?.value || '';
  c.portal = !!email;
  if (newPass) { c.password = newPass; c.has_password = true; } // only touch password if a new one was actually typed

  closeSheet('editCustSheet');
  saveFleet(); saveFleetToBackend(); renderAll();
  toast('✓ ' + c.name + ' updated', 'var(--green)');
}

function deleteCustomer() {
  const cid = document.getElementById('ecId').value;
  const c = customers.find(x => x.id === cid);
  if (!c) return;
  const affected = workers.filter(function(w){ return w.cid === cid; });
  const warning = affected.length > 0
    ? 'Delete ' + c.name + '? Their ' + affected.length + ' assigned miner(s) will become unassigned (not deleted) and the customer will lose portal access immediately. This cannot be undone.'
    : 'Delete ' + c.name + '? This cannot be undone.';
  if (!confirm(warning)) return;

  // Unassign their miners locally rather than leaving them pointing
  // at a customer id that no longer exists
  affected.forEach(function(w){ w.cid = ''; });
  customers = customers.filter(function(x){ return x.id !== cid; });

  saveFleet();
  saveFleetToBackend(); // persists the cid='' clearing on affected workers

  // The bulk save above is upsert-only (by design — see saveWorkers),
  // so it never removes the customer record itself. Deletion needs
  // its own explicit call, same reasoning as single-worker delete.
  const token = localStorage.getItem('ekl_token');
  if (token && API_BASE && !API_BASE.includes('localhost')) {
    fetch(API_BASE + '/api/fleet/customer/' + encodeURIComponent(cid), {
      method: 'DELETE',
      headers: {'Authorization':'Bearer '+token}
    }).catch(function(){});
  }

  closeSheet('editCustSheet');
  renderAll();
  toast('✓ ' + c.name + ' deleted' + (affected.length > 0 ? ' — ' + affected.length + ' miner(s) unassigned' : ''), 'var(--red)');
}

// ── Delete miner ──────────────────────────────────────────
function deleteMiner(wid) {
  if (!confirm('Remove this miner from fleet?')) return;
  workers = workers.filter(x => x.id !== wid);
  customers.forEach(c => { c.miners = c.miners.filter(x => x !== wid); });
  saveFleet();
  // This previously only cleared local storage — the backend was never
  // told, so the "deleted" machine would silently reappear next time
  // fleet data was reloaded from the server (its own poll cycle or any
  // fresh page load would restore it, since nothing ever removed it
  // from the database).
  const token = localStorage.getItem('ekl_token');
  if (token && API_BASE && !API_BASE.includes('localhost')) {
    fetch(API_BASE + '/api/fleet/worker/' + encodeURIComponent(wid), {
      method: 'DELETE',
      headers: {'Authorization':'Bearer '+token}
    }).catch(function(){});
  }
  saveFleetToBackend(); // also persist the customer.miners[] cleanup above
  closeCtrl();
  renderWorkers(); renderDash();
}

// ── Merge duplicate machine records ─────────────────────────
// Comes up after a reboot/outage changes a machine's IP and the poller
// had no MAC or serial to recognise it by — see the long comment on
// db.mergeWorkers on the backend for the full explanation. Two records,
// pick which to keep, fold the other's live readings into it, delete
// the other.
let mergeCandidateIds = [];
function openMergePicker() {
  const ids = Array.from(document.querySelectorAll('.worker-check:checked')).map(function(c){ return c.dataset.wid; });
  if (ids.length !== 2) { toast('Select exactly 2 machines to merge', 'var(--warn)'); return; }
  const a = workers.find(function(w){ return w.id === ids[0]; });
  const b = workers.find(function(w){ return w.id === ids[1]; });
  if (!a || !b) { toast('Could not find both selected machines', 'var(--red)'); return; }
  mergeCandidateIds = [a.id, b.id];

  // Default to keeping whichever one looks more "established" — has a
  // customer assigned, or a real hardware-based id, or was added
  // earlier — since that's usually the one worth preserving history for.
  function score(w){
    let s = 0;
    if (w.cid) s += 4;
    if (typeof w.id === 'string' && w.id.indexOf('w-ip-') !== 0) s += 2;
    if (w.name && !/^(unknown|w-ip-)/i.test(w.name)) s += 1;
    return s;
  }
  const defaultKeep = score(a) >= score(b) ? a.id : b.id;

  function card(w, checked){
    const cust = customers.find(function(c){ return c.id === w.cid; });
    return '<label style="display:flex;gap:10px;align-items:flex-start;border:1px solid var(--b1);border-radius:8px;padding:10px 12px;cursor:pointer">'
      + '<input type="radio" name="mergeKeep" value="' + escAttr(w.id) + '" style="margin-top:3px;accent-color:var(--cyan)"' + (checked ? ' checked' : '') + '>'
      + '<div style="flex:1;font-size:11px">'
      + '<div style="font-family:Share Tech Mono,monospace;font-weight:700;color:var(--cyan);font-size:13px">' + escHtml(w.name || w.id) + '</div>'
      + '<div style="color:var(--mute);margin-top:2px">' + escHtml(cleanBrandModel(w.brand)) + ' ' + escHtml(cleanBrandModel(w.model)) + ' &middot; ' + escHtml(w.ip || '—') + '</div>'
      + '<div style="color:var(--mute)">Status: <span style="color:' + (effectiveStatus(w)==='online' ? 'var(--green)' : 'var(--red)') + '">' + escHtml(effectiveStatus(w)) + '</span> &middot; ' + hrDisplay(w) + '</div>'
      + '<div style="color:var(--mute)">Customer: ' + (cust ? escHtml(cust.name) : '&mdash;') + ' &middot; Added: ' + escHtml((w.added_at||'').slice(0,10) || '—') + '</div>'
      + '<div style="color:var(--mute);font-family:Share Tech Mono,monospace;font-size:9px;margin-top:2px">id: ' + escHtml(w.id) + '</div>'
      + '</div></label>';
  }
  const box = document.getElementById('mergeCandidates');
  if (box) box.innerHTML = card(a, a.id === defaultKeep) + card(b, b.id === defaultKeep);
  openSheet('mergeSheet');
}
function confirmMergeWorkers() {
  const sel = document.querySelector('input[name="mergeKeep"]:checked');
  if (!sel || mergeCandidateIds.length !== 2) { toast('Pick which machine to keep', 'var(--warn)'); return; }
  const keepId = sel.value;
  const discardId = mergeCandidateIds.find(function(id){ return id !== keepId; });
  const token = localStorage.getItem('ekl_token');
  if (!token || !API_BASE || API_BASE.includes('localhost')) { toast('Not connected to backend', 'var(--red)'); return; }

  fetch(API_BASE + '/api/fleet/worker/merge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ keep_id: keepId, discard_id: discardId }),
  })
    .then(function(r){ return r.json().then(function(d){ return { ok: r.ok, d: d }; }); })
    .then(function(res){
      if (!res.ok || !res.d || !res.d.ok) {
        toast('Merge failed: ' + (res.d && res.d.error ? res.d.error : 'unknown error'), 'var(--red)');
        return;
      }
      workers = workers.filter(function(w){ return w.id !== discardId; });
      const idx = workers.findIndex(function(w){ return w.id === keepId; });
      if (idx >= 0) workers[idx] = res.d.worker; else workers.push(res.d.worker);
      customers.forEach(function(c){ c.miners = c.miners.filter(function(id){ return id !== discardId; }); });
      closeSheet('mergeSheet');
      mergeCandidateIds = [];
      _workersHash = '';
      renderWorkers(); renderDash();
      toast('✓ Merged into ' + (res.d.worker.name || keepId), 'var(--green)');
    })
    .catch(function(e){ toast('Merge failed: ' + e.message, 'var(--red)'); });
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
    workers.push({ id:'w-'+m.ip.replace(/\./g,'-'), name:m.worker||m.ip.replace(/\./g,'-'), model:m.model||'ASIC Miner', brand, algo, ip:m.ip, hashrate:m.hashrate||0, hr_unit:hrUnit, hr_display:(m.hashrate>0)?(m.hr_display||'—'):'—', temp:m.temp||0, fan:m.fan||0, power:m.power||0, status:(m.hashrate>0)?'online':'offline', pool:m.pool||'—', pool_url:m.pool||'', pool_user:m.worker||'', uptime:m.uptime||'—', farm:farmName, farm_id:farmId, cid:'', disabled:false, led:false, firmware:m.firmware||'—', accepted:m.accepted||0, rejected:m.rejected||0, hw_errors:m.hw_errors||0, source:'scan', added_at:new Date().toISOString() });
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
// (stub openIdospTab removed — full version defined later)
// (stub loadIdosp removed — full version defined later)
// (stub reloadSpFrame removed — full version defined later)
// (stub openSpCloud removed — full version defined later)
// (stub saveSpUrl removed — full version defined later)
// (stub loadSpFrame removed — full version defined later)

// ── Misc ──────────────────────────────────────────────────
// (stub logout removed — full version defined later)

function stopScan() {
  scanning = false;
  clearInterval(scanInt); clearInterval(scanTInt);
  const btn = document.getElementById('scanBtn'); if (btn) btn.textContent = '▶ Scan Network';
  const ssl = document.getElementById('scanCurrentSubnet'); if (ssl) { ssl.style.display = 'none'; ssl.textContent = ''; }
}

// (stub loadAgentConfigsFromBackend removed — full version defined later)

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
          let added = 0, updated = 0;
          const serverIds = new Set(d.workers.map(w => w.id));
          d.workers.forEach(bw => {
            // Match by id first, IP only as a fallback. Matching by IP
            // alone broke once the server started merging duplicates on
            // its own (services/dedupe.js): the surviving record keeps its
            // OLD id but moves to the NEW ip, so an IP match landed on the
            // local copy of the record that was just deleted, while the
            // local copy of the survivor kept the old ip forever — and
            // the next load then added the survivor a second time.
            //
            // The IP fallback is now only for a local copy the server
            // doesn't know under its own id, and only when the hardware
            // agrees. Otherwise a NEW machine that took an old machine's
            // IP was merged into that old machine's local record — and
            // showed its name.
            const existing = workers.find(lw => lw.id === bw.id)
              || workers.find(lw => lw.ip === bw.ip && !serverIds.has(lw.id) && !identityConflict(lw, bw, true));
            // In or out of service is decided on the server (Disable /
            // Enable), so it's taken from there every time — whichever
            // device did it. This used to be skipped entirely, and the
            // rest of the sync below was skipped for a disabled machine,
            // so a machine disabled or re-enabled elsewhere never changed
            // on this device.
            if (existing && !!existing.disabled !== !!bw.disabled) {
              existing.disabled = !!bw.disabled;
              existing.disabled_reason = bw.disabled_reason || null;
              existing.disabled_at = bw.disabled_at || null;
              if (bw.disabled) { existing.status = 'disabled'; existing.hashrate = 0; existing.hr_display = '—'; }
              else if (existing.status === 'disabled') existing.status = bw.status || 'offline';
              updated++;
            }
            // Which farm a machine belongs to (and that farm's name) is
            // decided on the server — by the agent that finds it, or by
            // renaming / merging farms in Remote Access — so this device
            // always takes it from there.
            if (existing && ((bw.farm_id && existing.farm_id !== bw.farm_id) || (bw.farm && existing.farm !== bw.farm))) {
              if (bw.farm_id) existing.farm_id = bw.farm_id;
              if (bw.farm) existing.farm = bw.farm;
              updated++;
            }
            if (!existing) {
              workers.push(bw); added++;
            } else if (!existing.disabled) {
              let changedThis = false;
              // The server's poll is what knows where a machine is now.
              if (existing.id === bw.id && bw.ip && existing.ip !== bw.ip) {
                existing.ip = bw.ip; changedThis = true;
                if (bw.farm_id) existing.farm_id = bw.farm_id;
                if (bw.farm) existing.farm = bw.farm;
              }
              // Sync live status AND readings from the server's poll-based
              // record (which reflects whether the agent actually saw this
              // machine in its last scan) — but never touch user-set
              // fields like name, model, or manual MAC/serial.
              //
              // This used to run only when the status STRING changed, and
              // to fall back to the local value whenever the server sent
              // null. Both meant a machine that went down kept showing its
              // last hashrate and temperature here indefinitely: the server
              // cleared them to 0/null, but with the status already
              // 'offline' on both sides there was nothing to trigger the
              // sync, and null would have been ignored in favour of the
              // stale local number even if there had been. The device then
              // pushed those numbers back on the next save. The server is
              // authoritative for all four of these, including when it
              // says there is no reading.
              if (existing.status !== bw.status) { existing.status = bw.status; changedThis = true; }
              const live = (bw.status === 'online' || bw.status === 'warn');
              const nHr   = live ? (bw.hashrate || 0)      : 0;
              const nTemp = live ? (bw.temp ?? null)       : null;
              const nFan  = live ? (bw.fan  ?? null)       : null;
              const nDisp = live ? (bw.hr_display || '—')  : '—';
              if (existing.hashrate   !== nHr)   { existing.hashrate   = nHr;   changedThis = true; }
              if (existing.temp       !== nTemp) { existing.temp       = nTemp; changedThis = true; }
              if (existing.fan        !== nFan)  { existing.fan        = nFan;  changedThis = true; }
              if (existing.hr_display !== nDisp) { existing.hr_display = nDisp; changedThis = true; }
              // model/brand/worker/worker_id/pool were never synced here at
              // all — this loop only ever touched status/hashrate/temp/fan/
              // hr_display/cid/name. So once a device's local cache had
              // "Unknown"/blank baked in for one of these (e.g. from a poll
              // that happened before a server-side identification fix, or
              // one that hit the miner's web server while it was too busy
              // to answer), it stayed stuck showing that forever on THIS
              // device — even after the backend had the correct value —
              // because nothing here ever pulled the fix down. Backend is
              // authoritative once it has a real (non-blank) reading, same
              // "never let a blank value win" rule as db.js's keepIfBetter.
              const syncIfBetter = (field, blanks) => {
                const v = bw[field];
                if (v && !blanks.includes(v) && existing[field] !== v) { existing[field] = v; changedThis = true; }
              };
              syncIfBetter('model', ['Unknown']);
              syncIfBetter('brand', ['']);
              syncIfBetter('worker', ['—']);
              syncIfBetter('worker_id', ['—']);
              syncIfBetter('pool', ['—']);
              // Customer assignment (cid) is authoritative from the
              // backend, always — unlike hashrate/temp there's no
              // legitimate reason a device's LOCAL cache would ever be
              // "more correct" than the backend here. Previously this
              // was never synced on an existing record at all, which
              // meant a device that had loaded the app BEFORE an
              // assignment was made would keep showing the old (empty)
              // assignment forever — exactly why a customer's portal
              // could work correctly on a fresh device but stay stuck
              // showing nothing on one that had opened the app before.
              if (existing.cid !== bw.cid) { existing.cid = bw.cid; changedThis = true; }
              // Name only fills in when THIS device's copy has none —
              // never overwrites a name someone actually typed in.
              // Machines discovered before the server-side backfill (see
              // db.js) got cached here locally with a blank name, same
              // as the server had at the time; the backfill fixed the
              // server's copy, but this additive merge never touches
              // `name` on a record that already exists locally, so a
              // device that had already cached the blank version kept
              // showing it forever even after the server was fixed —
              // exactly why the phone (which loaded fresh) was right
              // while the PC (which loaded before the fix) stayed blank.
              //
              // Names can't be typed in anywhere (they come from the pool
              // worker on the miner), so the server's name is authoritative.
              // Only filling in blanks meant a device that had cached a
              // wrong name — e.g. the previous machine's, after an IP swap —
              // kept showing it forever, even after the server corrected it.
              if (bw.name && bw.name !== '—' && existing.name !== bw.name) { existing.name = bw.name; changedThis = true; }
              if (changedThis) updated++;
            }
          });
          (d.customers || []).forEach(bc => {
            const lc = customers.find(x => x.id === bc.id);
            if (!lc) customers.push(bc);
            else Object.assign(lc, bc); // keep miners[]/portal/email in sync too
          });
          // Stale copies that exist ONLY on this device: a record under an
          // id the server doesn't have, at the same farm + IP as a machine
          // the server does have (same hardware as far as anyone can tell).
          // The server refuses to store these (routes/fleet.js), the id match
          // above never reaches them, so they sat here for ever as "offline"
          // machines — inflating this device's totals (Alhayer 101 here, 96
          // on the server) and answering "Worker not found" to Remove,
          // Disable and every other action. They are dropped; a customer
          // assigned only on the copy moves to the real record.
          {
            const atServer = new Map();
            d.workers.forEach(bw => { if (bw && bw.ip) atServer.set((bw.farm_id || '') + '|' + bw.ip, bw); });
            const stale = [];
            workers = workers.filter(lw => {
              if (!lw || serverIds.has(lw.id) || !lw.ip) return true;
              const real = atServer.get((lw.farm_id || '') + '|' + lw.ip);
              if (!real || identityConflict(lw, real, true)) return true;
              stale.push({ id: lw.id, real: real.id, cid: lw.cid });
              return false;
            });
            if (stale.length) {
              stale.forEach(x => {
                const keep = workers.find(w => w.id === x.real);
                if (keep && x.cid && !keep.cid) keep.cid = x.cid;
                customers.forEach(c => { if (Array.isArray(c.miners) && c.miners.indexOf(x.id) !== -1) c.miners = c.miners.map(id => id === x.id ? x.real : id).filter((id, i, a) => a.indexOf(id) === i); });
              });
              updated += stale.length;
              console.log('[FLEET] Dropped ' + stale.length + ' stale local copy/copies of machines the server already has');
            }
          }
          if (added > 0 || updated > 0) {
            saveFleet();
            _fleetHash = ''; _workersHash = '';
            console.log('[FLEET] +' + added + ' new, ' + updated + ' status updates from backend');
          }
        }
        // Apply deletions made on OTHER devices. This merge is otherwise
        // purely additive — it can tell "the server has something I
        // don't" but never "I have something that was deleted", so a
        // customer deleted on a laptop stayed on the phone forever, and
        // the phone would push it back to the server on its next save.
        // The server now says explicitly what was deleted.
        pruneDeletedLocally(d);
        loadAgentConfigsFromBackend();
        if (cb) cb();
      })
      .catch(() => { if (cb) cb(); });
  } catch(e) { if (cb) cb(); }
}

// Remove anything from this device's local copy that was deliberately
// deleted somewhere else. A record is only dropped if the server BOTH
// lists it as deleted AND isn't currently holding one — so a machine
// that was removed from the fleet and then rediscovered by the agent
// (still plugged in, still hashing) stays put rather than flickering
// in and out.
function pruneDeletedLocally(d) {
  if (!d || !Array.isArray(d.deleted) || d.deleted.length === 0) return;

  const liveWorkerIds   = new Set((d.workers   || []).map(function(w){ return w.id; }));
  const liveCustomerIds = new Set((d.customers || []).map(function(c){ return c.id; }));

  const deadWorkerIds = new Set(d.deleted
    .filter(function(t){ return t.kind === 'worker' && !liveWorkerIds.has(t.id); })
    .map(function(t){ return t.id; }));
  const deadCustomerIds = new Set(d.deleted
    .filter(function(t){ return t.kind === 'customer' && !liveCustomerIds.has(t.id); })
    .map(function(t){ return t.id; }));

  if (!deadWorkerIds.size && !deadCustomerIds.size) return;

  const beforeW = workers.length, beforeC = customers.length;
  if (deadWorkerIds.size) {
    workers = workers.filter(function(w){ return !deadWorkerIds.has(w.id); });
    // A machine that's gone shouldn't stay listed against a customer
    customers.forEach(function(c){
      if (Array.isArray(c.miners)) c.miners = c.miners.filter(function(id){ return !deadWorkerIds.has(id); });
    });
  }
  if (deadCustomerIds.size) {
    customers = customers.filter(function(c){ return !deadCustomerIds.has(c.id); });
    // ...and a miner shouldn't stay assigned to a customer that's gone
    workers.forEach(function(w){ if (deadCustomerIds.has(w.cid)) w.cid = ''; });
  }

  const removedW = beforeW - workers.length, removedC = beforeC - customers.length;
  if (removedW > 0 || removedC > 0) {
    saveFleet();
    _fleetHash = ''; _workersHash = '';
    console.log('[FLEET] Removed ' + removedW + ' machine(s) and ' + removedC + ' customer(s) deleted on another device');
    try { renderAll(); } catch(e) {}
  }
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
function setLTab(t,el){loginTab=t;document.querySelectorAll('.ltab').forEach(x=>x.classList.remove('active'));el.classList.add('active');const b=document.getElementById('lBtn'),h=document.getElementById('lHint'),u=document.getElementById('lUser'),p=document.getElementById('lPass');if(t==='customer'){b.className='login-btn customer';b.textContent='ENTER CUSTOMER PORTAL';h.textContent='Use the email/password set for this customer in Customers → Edit';u.value='';p.value='';}else if(t==='team'){b.className='login-btn admin';b.textContent='ACCESS PLATFORM';h.textContent='Use the username/password an admin set for you in Team Access';u.value='';p.value='';}else{b.className='login-btn admin';b.textContent='ACCESS PLATFORM';h.innerHTML='Admin: admin / admin123';u.value='admin';p.value='admin123';}}
function doLogin(){
  const u=document.getElementById('lUser').value.trim();
  const p=document.getElementById('lPass').value;
  const e=document.getElementById('lerr');
  e.style.display='none';
  if(!u||!p){e.textContent='Enter credentials';e.style.display='block';return;}

  // Previously this granted access immediately based only on a
  // username/email existing somewhere, without ever actually waiting
  // for the backend to confirm the password was correct — meaning
  // ANY password could log in as ANY user, admin included. Login now
  // waits for a genuine, verified response before entering the app.
  e.textContent = 'Signing in...'; e.style.display='block'; e.style.color = 'var(--mute)';

  fetch(API_BASE+'/api/auth/login',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({username:u,email:u,password:p})
  }).then(function(r){ return r.json(); })
  .then(function(d){
    if(!d.ok || !d.token){
      e.style.color = 'var(--red)';
      e.textContent = d.error || 'Invalid credentials';
      e.style.display='block';
      return;
    }
    localStorage.setItem('ekl_token', d.token);
    if(d.role === 'customer'){
      isCustomer = true;
      currentUser = { id: d.customer_id, name: d.name, role: 'customer' };
    } else {
      isCustomer = false;
      currentUser = { id: d.role + '-1', name: d.name, role: d.role };
    }
    e.style.display='none';
    launchApp();
  })
  .catch(function(){
    e.style.color = 'var(--red)';
    e.textContent = 'Could not reach server — check your connection';
    e.style.display='block';
  });
}
function launchApp(){['loginScreen'].forEach(id=>document.getElementById(id).style.display='none');['ticker','topbar','appBody','bottomNav'].forEach(id=>document.getElementById(id).style.display=id==='appBody'?'flex':id==='bottomNav'?'block':'flex');const ini=currentUser.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();document.getElementById('sideAv').textContent=ini;document.getElementById('sideName').textContent=currentUser.name;document.getElementById('sideRole').textContent=isCustomer?'Customer Portal':currentUser.role==='admin'?'Super Admin':'Team Member';document.getElementById('topBadge').textContent=isCustomer?'PORTAL':'ADMIN';if(isCustomer){document.getElementById('adminNav').style.display='none';document.getElementById('custNav').style.display='block';document.getElementById('agentPill').style.display='none';document.getElementById('bnavAdmin').style.display='none';document.getElementById('bnavCust').style.display='flex';showPage('portal-home');document.getElementById('custNav').querySelector('.nav-item').classList.add('active');renderPortal();try{ fetchMarketData(function(){ try{ renderPortal(); }catch(e){} }); loadFleetFromBackend(function(){ try{ renderPortal(); }catch(e){} }); fetchEarnings(); setInterval(fetchEarnings, 10*60*1000); }catch(e){}}else{populateDropdowns();renderAll();
// The fleet data driving stats/power was whatever this browser had
// cached locally (possibly nothing, e.g. right after "clear site
// data"). The only other refresh was a background interval kicked
// off at page load — before login — which could take up to 60s to
// fire again with a real token. Pulling fresh data the moment login
// succeeds closes that gap instead of leaving the dashboard looking
// like data was lost until the interval happens to catch up.
try{ loadFleetFromBackend(function(){ try{ renderAll(); }catch(e){} }); }catch(e){}
}
// Hand-entered model wattages live on the server so they apply on
// every device — fetch them before the first power roll-up is drawn.
try{ loadModelPower(function(){ try{ renderPowerPanel(); }catch(e){} }); }catch(e){}
// Restore the electricity tariff this device had typed in, so the
// per-day cost column isn't blank on every reload.
try{
  const _r = localStorage.getItem('ekl_elec_rate');
  const _el = document.getElementById('pwrRate');
  if (_r && _el) _el.value = _r;
}catch(e){}
initTicker();
// Live prices from CoinGecko. The old demo ticker invented prices with
// Math.random() and is gone.
fetchCoinPrices(); setInterval(fetchCoinPrices, 60000);
// NOTE: this setInterval was previously swallowed by a single-line
// comment on the same line, so liveUpdate never actually ran.
setInterval(liveUpdate,30000);fetchAgents();setInterval(fetchAgents,30000);
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
        // farm management (Remote Access → Farms / New agents)
        if(msg.type==='agent_pending' || msg.type==='farm_renamed' || msg.type==='farms_changed') { loadFarms(); fetchAgents(); }
        if(msg.type==='agent_connected' || msg.type==='agent_disconnected') loadFarms();

        // Live auto-discovery: the agent polls its whole subnet every
        // 30s independent of any manual scan. New machines appear here
        // instantly; machines that stop responding get merged in as
        // offline. This is what keeps the Workers page live without
        // anyone needing to run a scan.
        if(msg.type==='poll_result' && Array.isArray(msg.miners)){
          mergePollResults(msg.farm_id, msg.miners);
        }
      } catch(e) {}
    };
    liveWs.onerror = () => {};
  } catch(e) {}
} // end launchApp

// ── Merge live poll results into the local fleet ───────────
// Mirror of the backend's stableWorkerId() — both sides MUST generate
// the same id for the same machine, or the browser and the server will
// each invent a different identity for it and create duplicate records.
// MAC/serial are permanent hardware ids; IP is a last resort only,
// because on DHCP it changes and would silently re-identify the machine.
function stableWorkerId(m) {
  if (m.mac)    return 'w-mac-' + String(m.mac).toUpperCase().replace(/[^0-9A-F]/g, '');
  if (m.serial) return 'w-sn-'  + String(m.serial).replace(/[^0-9A-Za-z]/g, '');
  return 'w-ip-' + String(m.ip).replace(/\./g, '-');
}

// Do these two describe different machines? Same rule as the server
// (db.js identityConflict): different MAC, different serial, or — when
// only an IP matched — a different pool worker. Used so a machine that
// took over another's old IP isn't merged into that machine's record,
// which is what made the previous machine's name show on the new one.
function idMac(v){ if(!v) return null; var h=String(v).toUpperCase().replace(/[^0-9A-F]/g,''); return (h.length===12 && !/^0+$/.test(h) && !/^F+$/.test(h)) ? h : null; }
function idSerial(v){ if(!v) return null; var s=String(v).trim(); return (s.length>=4 && !/^(—|-|0+|unknown|none|null|n\/a)$/i.test(s)) ? s : null; }
function idWorker(o){ var v=o && (o.worker_id || o.worker); var s=v ? String(v).trim() : ''; return (s && s!=='—') ? s : null; }
function identityConflict(a, b, checkWorker){
  if(!a || !b) return false;
  var ma=idMac(a.mac), mb=idMac(b.mac); if(ma && mb && ma!==mb) return true;
  var sa=idSerial(a.serial), sb=idSerial(b.serial); if(sa && sb && sa!==sb) return true;
  if(checkWorker){ var wa=idWorker(a), wb=idWorker(b); if(wa && wb && wa!==wb) return true; }
  return false;
}

function mergePollResults(farmId, minersFoundNow){
  if(!farmId || !Array.isArray(minersFoundNow)) return;
  const nowIps = new Set(minersFoundNow.map(function(m){ return m.ip; }));
  let changed = false;

  // Find an existing worker record for this poll result — checking
  // MAC and Serial FIRST, across the whole fleet (not just this farm).
  // A machine physically moved between sites keeps its MAC/Serial but
  // gets a new IP — matching by those hardware IDs first is what
  // recognizes "this is the same miner, just relocated" instead of
  // creating a duplicate entry under the new address.
  function findExistingWorker(m){
    if (m.mac) {
      const byMac = workers.find(function(w){ return w.mac && w.mac === m.mac; });
      if (byMac) return byMac;
    }
    if (m.serial) {
      const bySerial = workers.find(function(w){ return w.serial && w.serial === m.serial; });
      if (bySerial) return bySerial;
    }
    const byIp = workers.find(function(w){ return w.ip === m.ip && w.farm_id === farmId; }) || null;
    // A different machine now has this IP: don't touch that record, and
    // don't create one here either — the server creates the new record
    // and the next fleet load brings it in with the server's id.
    if (byIp && identityConflict(m, byIp, true)) return 'skip';
    return byIp;
  }

  // Update or add every miner this poll found
  minersFoundNow.forEach(function(m){
    const existing = findExistingWorker(m);
    if (existing === 'skip') return;
    if(existing){
      if(!existing.disabled){
        const moved = existing.ip !== m.ip || existing.farm_id !== farmId;
        if (moved) {
          const newFarmName = (agents.find(function(a){ return a.id === farmId; }) || {}).name || farmId;
          console.log('[MERGE] ' + (existing.name||existing.ip) + ' moved: ' + existing.farm + '(' + existing.ip + ') \u2192 ' + newFarmName + '(' + m.ip + ')');
          existing.ip      = m.ip;
          existing.farm_id = farmId;
          existing.farm    = newFarmName;
          toast('\uD83D\uDCE6 ' + (existing.name||m.ip) + ' relocated to ' + newFarmName, 'var(--cyan)');
        }
        // Only these fields refresh on every scan — everything else
        // (name, model, brand, algo, MAC, serial, pool, customer)
        // stays exactly as it was first detected or as manually edited.
        // Once a MAC/Serial is found, it's permanent — no re-detection needed.
        existing.hashrate   = m.hashrate   ?? existing.hashrate;
        existing.hr_unit    = m.hr_unit    || existing.hr_unit;
        existing.hr_display = (m.hashrate > 0) ? (m.hr_display || existing.hr_display) : '—';
        existing.temp       = m.temp       ?? existing.temp;
        existing.fan        = m.fan        ?? existing.fan;
        existing.power      = m.power      ?? existing.power;
        // Zero hashrate = not actually mining, even if the machine
        // responded on the network — treat it as offline, not online.
        existing.status     = (m.hashrate > 0) ? 'online' : 'offline';
        existing.uptime     = m.uptime     || existing.uptime;
        existing.accepted   = m.accepted   ?? existing.accepted;
        existing.rejected   = m.rejected   ?? existing.rejected;
        existing.hw_errors  = m.hw_errors  ?? existing.hw_errors;

        // MAC/Serial: only fill in if currently missing — never overwrite
        // an already-known value, and never overwrite a manual edit
        if (!existing.mac_manual && !existing.mac && m.mac) existing.mac = m.mac;
        if (!existing.serial_manual && !existing.serial && m.serial) existing.serial = m.serial;

        // The name follows the pool worker the miner reports (there is no
        // manual rename; "Set Worker ID" changes it on the miner too).
        if (m.worker && m.worker !== '—' && existing.name !== m.worker) existing.name = m.worker;
        if (m.worker_id && m.worker_id !== '—') existing.worker_id = m.worker_id;

        changed = true;
      }
    } else {
      // Brand new machine detected on the network — add it automatically
      const algo    = m.algo || getAlgoFromModel(m.model || '');
      const brand   = m.brand || detectBrand(m.model || '');
      const ghAlgos = ['Scrypt','KHeavyHash','X11','Blake2B','Ethash','Equihash'];
      const hrUnit  = m.hr_unit || (ghAlgos.includes(algo) ? 'GH/s' : 'TH/s');
      const farmName= (agents.find(function(a){ return a.id === farmId; }) || {}).name || farmId;
      workers.push({
        id: stableWorkerId(m), name: m.worker || m.ip.replace(/\./g,'-'),
        worker_id: m.worker_id || m.worker || '—', model: m.model || 'ASIC Miner',
        brand: brand, algo: algo, ip: m.ip,
        hashrate: m.hashrate || 0, hr_unit: hrUnit, hr_display: (m.hashrate > 0) ? (m.hr_display || '—') : '—',
        temp: m.temp || 0, fan: m.fan || 0, power: m.power || 0, status: (m.hashrate > 0) ? 'online' : 'offline',
        pool: m.pool || '—', pool_url: m.pool || '', pool_user: m.worker || '',
        uptime: m.uptime || '—', farm: farmName, farm_id: farmId, cid: '',
        disabled: false, led: false, firmware: m.firmware || '—',
        mac: m.mac || null, serial: m.serial || null,
        accepted: m.accepted || 0, rejected: m.rejected || 0, hw_errors: m.hw_errors || 0,
        source: 'auto-poll', added_at: new Date().toISOString(),
      });
      changed = true;
      toast('&#x26CF; New machine detected: ' + m.ip + ' (' + farmName + ')', 'var(--green)');
    }
  });

  // Anything under this farm that this poll DIDN'T see is now offline —
  // it was either unplugged, moved to another farm (handled above,
  // its farm_id already changed so it won't match here), or is
  // unreachable right now
  workers.forEach(function(w){
    if(w.farm_id === farmId && !w.disabled && !nowIps.has(w.ip) && w.status !== 'offline'){
      w.status = 'offline';
      changed = true;
    }
  });

  if(changed){
    _fleetHash = ''; _workersHash = '';
    saveFleet();
    try { renderWorkers(); } catch(e) {}
    try { renderDash(); } catch(e) {}
  }
}

if('serviceWorker'in navigator)navigator.serviceWorker.register('sw.js').catch(()=>{});
// If eWeLink just sent us back here with a login code, finish the connection
try { handleEwelinkCallback(); } catch(e) {}
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

  // Refresh the Workers page from the backend every 60s — a reliable
  // fallback alongside the live WebSocket updates, in case the socket
  // ever drops or a poll_result message is missed
  setInterval(function(){
    try{ loadFleetFromBackend(function(){ try{ renderWorkers(); renderDash(); }catch(e){} }); }catch(e){}
  }, 60000);
  const d=document.getElementById('currentApiDisplay');if(d)d.textContent=API_BASE;
  const ai=document.getElementById('apiUrl');if(ai)ai.value=API_BASE;
function logout(){location.reload();}

// NAV
function showPage(n){
  document.querySelectorAll('.page').forEach(function(p){ p.classList.remove('active'); });
  const pg = document.getElementById('page-'+n);
  if(pg) pg.classList.add('active');
  // Render the page's content when it opens
  try {
    if(n==='dashboard')     { renderDash(); }
    if(n==='settings')      { loadSiteAlarmSetting(); loadAutoRestart(); loadTgRules(); loadLogRules(); }
    if(n==='workers')       { renderWorkers(); attachSortHandlers(); }
    if(n==='agents')        { renderAgents(); populateDropdowns(); loadFarms(); }
    if(n==='customers')     { renderCustomers(); }
    if(n==='team')          { loadTeamFromBackend(); }
    if(n==='alerts')        { renderAlerts(); }
    if(n==='scada')         { checkScadaSession(); }
    if(n==='pools')         { renderPools(); }
    if(n==='profitability') { fetchMarketData(function(){ renderProfit(); }); renderProfit(); }
    if(n==='settings')      { updateFleetStat(); renderSensorEntryGrid(); const tt=document.getElementById('tailscaleToggle'); if(tt) tt.checked = localStorage.getItem('use_tailscale_webui') === 'true'; const rr=document.getElementById('ewRedirectUrl'); if(rr && !rr.value) rr.value = window.location.origin + window.location.pathname; }
  } catch(e) { console.error('showPage render error:', e); }
}
function nav(page,el){showPage(page);document.querySelectorAll('.nav-item').forEach(x=>x.classList.remove('active'));if(el)el.classList.add('active');}

// ── Remote Access page: Farm Agents / Network Scanner tabs ──
// Farm Agents and Network Scanner used to be two separate nav pages;
// they're now two sections of one "Remote Access" page, toggled here
// instead of navigated to, since a scan in progress shouldn't be torn
// down just because a page switch unmounted it.
function setRemoteAccessTab(which){
  const agentsSec  = document.getElementById('raSectionAgents');
  const scannerSec = document.getElementById('raSectionScanner');
  const agentsBtn  = document.getElementById('raTabAgentsBtn');
  const scannerBtn = document.getElementById('raTabScannerBtn');
  if (agentsSec)  agentsSec.style.display  = (which === 'agents')  ? '' : 'none';
  if (scannerSec) scannerSec.style.display = (which === 'scanner') ? '' : 'none';
  if (agentsBtn)  agentsBtn.classList.toggle('active', which === 'agents');
  if (scannerBtn) scannerBtn.classList.toggle('active', which === 'scanner');
  if (which === 'scanner') populateDropdowns();
}

// TICKER
// Sub-dollar coins (KAS) need more decimals or they'd all read "$0".
function fmtCoinPrice(v) {
  if (!isFinite(v) || v <= 0) return '—';
  if (v >= 1000) return '$' + Math.round(v).toLocaleString();
  if (v >= 1)    return '$' + v.toFixed(2);
  return '$' + v.toFixed(4);
}

function initTicker() {
  const track = document.getElementById('tickTrack');
  if (!track) return;
  let h = '';
  Object.keys(COIN_META).forEach(function(k){
    const meta = COIN_META[k];
    const row  = coinPrices && coinPrices[k];
    let priceHtml, chgHtml;
    if (!row) {
      // Feed down or this coin missing from the response — say so
      // rather than showing the last price as if it were current.
      priceHtml = '<span class="t-price">—</span>';
      chgHtml   = '';
    } else {
      priceHtml = '<span class="t-price">' + fmtCoinPrice(row.usd) + '</span>';
      // Guard against null explicitly: Number(null) is 0, which would
      // render a missing 24h change as a confident "+0.00%".
      const c = (row.change_24h === null || row.change_24h === undefined)
        ? NaN : Number(row.change_24h);
      chgHtml = isFinite(c)
        ? '<span class="t-chg ' + (c >= 0 ? 'up' : 'dn') + '">' + (c >= 0 ? '+' : '') + c.toFixed(2) + '%</span>'
        : '';
    }
    h += '<div class="tick-item"><span class="t-sym" style="color:' + meta.col + '">'
       + meta.ico + ' ' + k + '</span>' + priceHtml + chgHtml + '</div>';
  });
  // Duplicated once so the marquee animation loops seamlessly
  track.innerHTML = h + h;
}

// Real prices from CoinGecko, cached server-side so every logged-in
// user shares one upstream call. Polled on a 60s cadence to match
// the backend cache — polling faster would just re-serve the same
// cached figures.
function fetchCoinPrices() {
  const base = (typeof API_BASE !== 'undefined') ? API_BASE : '';
  if (!base || base.includes('localhost')) return;
  fetch(base + '/api/market/prices')
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(d){
      coinPrices = (d && d.ok && d.prices) ? d.prices : null;
      initTicker();
    })
    .catch(function(){ coinPrices = null; initTicker(); });
}

// HELPERS
// Is this worker's farm agent currently connected?
// Guards against bad/garbage text ever landing in the Brand/Model
// column (HTML error pages, connection errors saved from old scans, etc.)
function cleanBrandModel(val){
  if (!val || typeof val !== 'string') return '—';
  const s = val.trim();
  if (s.length === 0) return '—';
  if (s.length > 40 || /<[a-z]|not found|error|refused|forbidden|unauthorized|timeout|http\/|request for url/i.test(s)) {
    return 'Unknown';
  }
  return s;
}

// Until the agent list has actually loaded, nothing is known about the
// agents — so nothing is claimed: each machine shows the status the server
// last recorded for it. (It used to count as "every agent offline", which
// painted the whole fleet red — 0 online, 261 offline — whenever that one
// request was slow or failed, while Remote Access showed everything online.)
let agentsKnown = false;
function isAgentOnline(farmId){
  if (!agentsKnown) return true;
  const a = agents.find(function(x){ return x.id === farmId; });
  return !!(a && a.online);
}

// The worker's REAL status right now — if its agent is offline,
// the worker can't actually be confirmed online no matter what its
// last reported status was, so it's shown as offline too.
function effectiveStatus(w){
  if (w.disabled) return 'disabled';
  if (w.farm_id && !isAgentOnline(w.farm_id)) return 'offline';
  return w.status || 'offline';
}

function sdot(w){
  const s = effectiveStatus(w);
  return s==='disabled'?'dis':s==='sleeping'?'slp':s==='rebooting'?'rb':s==='online'?'on':s==='warn'?'wn':'off';
}
function sbadge(w){const m={online:'bgn',warn:'bwn',offline:'brn',disabled:'bor',sleeping:'bpp',rebooting:'bc'};const l={online:'ONLINE',warn:'WARNING',offline:'OFFLINE',disabled:'DISABLED',sleeping:'SLEEPING',rebooting:'REBOOTING'};return `<span class="badge ${m[w.status]||'bc'}">${l[w.status]||w.status.toUpperCase()}</span>`;}
function getAlgoFromModel(model){
  const m=(model||'').toLowerCase();
  // Scrypt — LTC miners: L3, L3+, L5, L7, L9, L11, L15, L19
  // Match: "l3", "l3+", "l5", "l7", "l9", "l11", "l15", "l19", "antminer l", etc.
  if(/\bl[0-9]+/.test(m)||m.includes('scrypt')||m.includes('litecoin')||m.includes('ltc')||m.includes(' l3')||m.includes(' l5')||m.includes(' l7')||m.includes(' l9')||m.includes('elphapex')||m.includes('dg1')||m.includes('dg-1')) return 'Scrypt';
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
// ── Team Access — real staff accounts, stored server-side via
// /api/team (admin-only). Separate from customers (portal, miners-
// only) and from the three hardcoded demo logins in auth.js.
let team = [];
// "viewer" is no longer offered — it promised read-only access that
// nothing in the app enforced. It stays in this map only so an account
// created under it before still shows a sensible label; editing one
// moves it to Technician, which is the access it always actually had.
const ROLE_LABELS = { team: 'Team Member', technician: 'Technician', viewer: 'Technician' };

function loadTeamFromBackend(cb) {
  const token = localStorage.getItem('ekl_token');
  if (!token || !API_BASE || API_BASE.includes('localhost')) { if (cb) cb(); return; }
  fetch(API_BASE + '/api/team', { headers: { 'Authorization': 'Bearer ' + token } })
    .then(function(r){ return r.ok ? r.json() : { ok:false }; })
    .then(function(d){ if (d.ok) team = d.members || []; renderTeam(); if (cb) cb(); })
    .catch(function(){ if (cb) cb(); });
}

function renderTeam() {
  const grid = document.getElementById('teamGrid');
  if (!grid) return;

  // Only an admin can see or manage this page — a team member has no
  // business creating or removing other staff accounts, including
  // their own. currentUser.role is whatever the login response set.
  if (!currentUser || currentUser.role !== 'admin') {
    grid.innerHTML = '<div style="text-align:center;padding:40px;color:var(--mute)">Team Access is admin-only.</div>';
    const addBtn = document.getElementById('teamAddBtn'); if (addBtn) addBtn.style.display = 'none';
    return;
  }
  const addBtn = document.getElementById('teamAddBtn'); if (addBtn) addBtn.style.display = '';

  const CC = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22','#34495e'];
  grid.innerHTML = team.length === 0
    ? '<div style="text-align:center;padding:40px;color:var(--mute)">No team accounts yet. Add one so staff can log in with their own username instead of sharing the admin login.</div>'
    : team.map(function(m, i){
      const col = CC[i % CC.length];
      const ini = (m.name||'?').split(' ').map(function(w){return w[0];}).join('').slice(0,2).toUpperCase();
      return '<div class="card"><div class="card-head"><div class="av" style="background:' + col + ';width:38px;height:38px;font-size:15px">' + ini + '</div>'
        + '<div><div style="font-family:Exo 2,sans-serif;font-weight:700;font-size:13px">' + escHtml(m.name) + '</div><div style="font-size:10px;color:var(--mute)">@' + escHtml(m.username) + '</div></div>'
        + '<span class="badge ' + (m.active === false ? 'brn' : 'bgn') + '" style="margin-left:auto">' + (m.active === false ? 'DISABLED' : (ROLE_LABELS[m.role] || m.role || 'Team Member').toUpperCase()) + '</span></div>'
        + '<div class="card-foot"><button class="btn btn-sm edit-team-btn" data-tid="' + m.id + '">&#x270E; Edit</button></div></div>';
    }).join('');

  grid.querySelectorAll('.edit-team-btn').forEach(function(btn){
    btn.addEventListener('click', function(){ openEditTeamMember(this.dataset.tid); });
  });
}

function addTeamMember() {
  const name = document.getElementById('tName')?.value.trim();
  const username = document.getElementById('tUser')?.value.trim();
  const password = document.getElementById('tPass')?.value || '';
  const role = document.getElementById('tRole')?.value || 'team';
  if (!name)     { alert('Name required'); return; }
  if (!username) { alert('Username required'); return; }
  if (password.length < 6) { alert('Password must be at least 6 characters'); return; }

  const token = localStorage.getItem('ekl_token');
  fetch(API_BASE + '/api/team', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ name, username, password, role })
  }).then(function(r){ return r.json().then(function(d){ return { status: r.status, d: d }; }); })
    .then(function(res){
      if (!res.d.ok) { toast(res.d.error || 'Could not create team member', 'var(--red)'); return; }
      team.push(res.d.member);
      closeSheet('addTeamSheet');
      ['tName','tUser','tPass'].forEach(function(id){ const el = document.getElementById(id); if (el) el.value = ''; });
      renderTeam();
      toast('✓ ' + res.d.member.name + ' can now log in with their own account', 'var(--green)');
    })
    .catch(function(e){ toast('Error: ' + e.message, 'var(--red)'); });
}

function openEditTeamMember(tid) {
  const m = team.find(function(x){ return x.id === tid; });
  if (!m) return;
  document.getElementById('etId').value = tid;
  document.getElementById('etName').value = m.name || '';
  document.getElementById('etUser').value = m.username || '';
  document.getElementById('etPass').value = '';
  document.getElementById('etPass').placeholder = 'Leave blank to keep current password';
  // A role that's no longer offered (the old "viewer") has no matching
  // option, which would leave the select blank — fall back to Technician
  document.getElementById('etRole').value = (m.role === 'team' || m.role === 'technician') ? m.role : 'technician';
  document.getElementById('etActive').checked = m.active !== false;
  openSheet('editTeamSheet');
}

function saveEditTeamMember() {
  const tid = document.getElementById('etId').value;
  const m = team.find(function(x){ return x.id === tid; });
  if (!m) return;
  const name = document.getElementById('etName')?.value.trim();
  const username = document.getElementById('etUser')?.value.trim();
  const newPass = document.getElementById('etPass')?.value || '';
  const role = document.getElementById('etRole')?.value || 'team';
  const active = document.getElementById('etActive')?.checked;
  if (!name)     { alert('Name required'); return; }
  if (!username) { alert('Username required'); return; }
  if (newPass && newPass.length < 6) { alert('Password must be at least 6 characters'); return; }

  const body = { name, username, role, active };
  if (newPass) body.password = newPass;

  const token = localStorage.getItem('ekl_token');
  fetch(API_BASE + '/api/team/' + encodeURIComponent(tid), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify(body)
  }).then(function(r){ return r.json().then(function(d){ return { status: r.status, d: d }; }); })
    .then(function(res){
      if (!res.d.ok) { toast(res.d.error || 'Could not update team member', 'var(--red)'); return; }
      Object.assign(m, res.d.member);
      closeSheet('editTeamSheet');
      renderTeam();
      toast('✓ ' + m.name + ' updated', 'var(--green)');
    })
    .catch(function(e){ toast('Error: ' + e.message, 'var(--red)'); });
}

function deleteTeamMember() {
  const tid = document.getElementById('etId').value;
  const m = team.find(function(x){ return x.id === tid; });
  if (!m) return;
  if (!confirm('Remove ' + m.name + '’s team account? They will no longer be able to log in. This cannot be undone.')) return;

  const token = localStorage.getItem('ekl_token');
  fetch(API_BASE + '/api/team/' + encodeURIComponent(tid), {
    method: 'DELETE',
    headers: { 'Authorization': 'Bearer ' + token }
  }).then(function(r){ return r.json(); })
    .then(function(d){
      if (!d.ok) { toast('Could not delete team member', 'var(--red)'); return; }
      team = team.filter(function(x){ return x.id !== tid; });
      closeSheet('editTeamSheet');
      renderTeam();
      toast('✓ ' + m.name + ' removed', 'var(--red)');
    })
    .catch(function(e){ toast('Error: ' + e.message, 'var(--red)'); });
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

// (duplicate renderAll removed)

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
        agentsKnown = true; agentsFailCount = 0;
        updateAgentUI();
        // which agents are online changed (or just became known) → redraw
        // the machine statuses that depend on it straight away
        const sig = agents.map(function(x){ return x.id + (x.online ? '+' : '-'); }).sort().join('|');
        if (sig !== agentsSig) { agentsSig = sig; try { _fleetHash = ''; _workersHash = ''; renderDash(); renderWorkers(); } catch (e) {} }
      }
    })
    .catch(err => {
      console.warn('[EKL] fetchAgents failed:', err.message);
      // Second source: the farm list (Remote Access) knows which farms
      // have an agent online. Then try the agent list again shortly.
      agentsFailCount++;
      agentsFromFarms(true);
      if (agentsFailCount <= 5) setTimeout(fetchAgents, 5000);
    });
}
let agentsFailCount = 0, agentsSig = null;
// Build / refresh the agent list from the farm list when the agent list
// itself could not be loaded.
function agentsFromFarms(fetchIfNeeded) {
  if (agentsKnown && agentsFailCount === 0) return;
  const use = function(farms){
    if (!Array.isArray(farms) || !farms.length) return;
    agents = farms.map(function(f){
      const pc = (f.pcs || []).find(function(p){ return p.online; }) || (f.pcs || [])[0] || {};
      return { id: f.farm_id, name: f.name || f.farm_id, subnet: (f.subnets || []).join(', ') || '(auto)', host: pc.hostname || 'unknown',
               ver: pc.version || '1.0.0', online: !!f.online, count: f.machines || 0, lastSeen: f.online ? 'Just now' : '—', lastPoll: f.online ? 'Just now' : '—' };
    });
    agentsKnown = true;
    try { updateAgentUI(); } catch (e) {}
    try { _fleetHash = ''; _workersHash = ''; renderDash(); renderWorkers(); } catch (e) {}
  };
  if (typeof farmsState !== 'undefined' && farmsState.farms && farmsState.farms.length) return use(farmsState.farms);
  if (!fetchIfNeeded || (typeof isCustomer !== 'undefined' && isCustomer)) return;
  authFetch('/api/farms').then(function(d){ if (d && d.ok) use(d.farms); });
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
    { v: online,    color: '#00ff9d', label: 'Online'   },
    { v: offline,   color: '#ff2d55', label: 'Offline'  },
    { v: disabled_, color: '#ff6b35', label: 'Disabled' },
  ].filter(d => d.v > 0);

  let paths = '', startAngle = -Math.PI / 2;
  // Special case: a single segment covering 100% — draw as two half-circle arcs
  // (a full-circle arc with identical start/end points renders as nothing in SVG)
  if (data.length === 1) {
    const seg = data[0];
    const midAngle = startAngle + Math.PI;
    const p = (a, radius) => [ (cx + radius*Math.cos(a)).toFixed(1), (cy + radius*Math.sin(a)).toFixed(1) ];
    const [ox1,oy1] = p(startAngle, r), [ox2,oy2] = p(midAngle, r), [ox3,oy3] = p(startAngle + 2*Math.PI, r);
    const [ix1,iy1] = p(startAngle, inner), [ix2,iy2] = p(midAngle, inner), [ix3,iy3] = p(startAngle + 2*Math.PI, inner);
    paths += '<path d="M'+ox1+','+oy1+' A'+r+','+r+' 0 1,1 '+ox2+','+oy2+' A'+r+','+r+' 0 1,1 '+ox3+','+oy3
           + ' L'+ix3+','+iy3+' A'+inner+','+inner+' 0 1,0 '+ix2+','+iy2+' A'+inner+','+inner+' 0 1,0 '+ix1+','+iy1
           + ' Z" style="fill:'+seg.color+'" opacity="0.85"/>';
  } else {
    data.forEach(seg => {
      const angle = (seg.v / total) * 2 * Math.PI;
      const end   = startAngle + angle;
      const x1o = cx + r     * Math.cos(startAngle), y1o = cy + r     * Math.sin(startAngle);
      const x2o = cx + r     * Math.cos(end),         y2o = cy + r     * Math.sin(end);
      const x1i = cx + inner * Math.cos(end),         y1i = cy + inner * Math.sin(end);
      const x2i = cx + inner * Math.cos(startAngle),  y2i = cy + inner * Math.sin(startAngle);
      const large = angle > Math.PI ? 1 : 0;
      paths += `<path d="M${x1o.toFixed(1)},${y1o.toFixed(1)} A${r},${r} 0 ${large},1 ${x2o.toFixed(1)},${y2o.toFixed(1)} L${x1i.toFixed(1)},${y1i.toFixed(1)} A${inner},${inner} 0 ${large},0 ${x2i.toFixed(1)},${y2i.toFixed(1)} Z" style="fill:${seg.color}" opacity="0.85"/>`;
      startAngle = end;
    });
  }

  // Center text
  paths += `<text x="60" y="57" text-anchor="middle" font-size="18" font-family="Share Tech Mono" style="fill:#00c8ff">${total}</text>`;
  paths += `<text x="60" y="70" text-anchor="middle" font-size="8" font-family="Exo 2" style="fill:#3d5570">MINERS</text>`;
  svg.innerHTML = paths;

  leg.innerHTML = data.map(d =>
    '<div style="display:flex;justify-content:space-between;padding:2px 0">'
    + '<span style="color:' + d.color + '">&#9679; ' + d.label + '</span>'
    + '<span style="font-family:Share Tech Mono,monospace;color:#bdd0e0">' + d.v + '</span>'
    + '</div>'
  ).join('');
  if (data.length === 0) leg.innerHTML = '<div style="color:#3d5570;text-align:center">No data</div>';
}

// Every dashboard redraw also redraws the power-by-site table and the
// sidebar machine count. Many live-update paths (agent polls, the
// periodic fleet refresh, opening the dashboard) call renderDash()
// alone, so the power table used to keep whatever fleet it was last
// drawn from: after duplicates were merged, the ring showed 262 machines
// while the power table still counted 431 "running". Now power per site
// always follows the machines that are online right now, including
// machines added or removed since.
function renderDash(){
  try { renderDashCore(); }
  finally {
    try { renderPowerPanel(); } catch(e) { console.error('renderPowerPanel:', e); }
    try { updateNavCount(); } catch(e) {}
  }
}

function renderDashCore(){
  const alertList = updateAlertBadges();
  const dAl = document.getElementById('dAlerts'); if (dAl) dAl.textContent = alertList.length;
  const disabled = workers.filter(w=>w.disabled);
  const online   = workers.filter(w=>!w.disabled && effectiveStatus(w)==='online');
  const offline  = workers.filter(w=>!w.disabled && effectiveStatus(w)!=='online');
  const warning  = workers.filter(w=>!w.disabled && w.status==='warn' && effectiveStatus(w)==='online');

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
  // NEVER reassign a worker's farm_id to a different agent just because
  // only one happens to be online right now — that silently corrupts
  // which farm a machine actually belongs to. Each worker always stays
  // under its own recorded farm, shown as offline if that agent isn't
  // currently connected.
  const farmMap = {};
  agents.forEach(a => {
    farmMap[a.id] = { id:a.id, name:a.name, workers:[], agent:a };
  });
  workers.forEach(w => {
    const fid = w.farm_id || 'unknown';
    if (!farmMap[fid]) {
      // This worker's farm isn't currently connected — show it under its
      // OWN recorded farm name, marked offline, never merged into another agent
      farmMap[fid] = { id: fid, name: w.farm || fid, workers: [], agent: null };
    }
    farmMap[fid].workers.push(w);
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
          <div style="grid-column:1/-1"><div style="color:var(--mute)">Power</div><div style="font-family:'Share Tech Mono',monospace;color:var(--purp,var(--cyan))">${fmtKW(farm.workers.reduce(function(a,w){return a+minerWatts(w).watts;},0))}</div></div>
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
    const ag      = farm.agent;
    const onl     = ag && ag.online;
    const repair  = farm.workers.filter(function(w){return w.disabled;}).length;
    // If the agent itself is offline, none of its miners can be confirmed
    // online right now — regardless of their last reported status
    const online  = onl ? farm.workers.filter(function(w){return !w.disabled && w.status==='online';}).length : 0;
    const offline = farm.workers.length - online - repair;
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
        const eSt=effectiveStatus(w);
        return `<tr style="border-bottom:1px solid rgba(26,42,58,.4)">
          <td style="padding:7px 10px"><span class="sdot ${sdot(w)}"></span></td>
          <td style="padding:7px 10px"><div style="font-family:'Exo 2',sans-serif;font-weight:600">${w.name}</div><div style="font-size:9px;color:var(--mute)">${w.ip}</div></td>
          <td style="padding:7px 10px;color:var(--mute)">${w.brand||''} ${w.model}</td>
          <td style="padding:7px 10px;color:var(--green)">${eSt==='online'?hrDisplay(w):'—'}</td>
          <td style="padding:7px 10px;${tc}">${eSt==='online'&&w.temp>0?w.temp+'°C':'—'}</td>
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
      ${r.model?`<span style="font-family:'Share Tech Mono',monospace;font-size:9px;color:var(--cyan);background:rgba(0,200,255,.08);border:1px solid rgba(0,200,255,.2);border-radius:3px;padding:2px 6px">${r.model}</span>`:''}
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
  if(!mac&&!ip){alert('Enter a MAC address, an IP range, or both');return;}
  const status=document.getElementById('sensorDiscoverStatus');
  status.style.color='var(--cyan)';

  const token=localStorage.getItem('ekl_token');
  if(!token){status.textContent='Not logged in';status.style.color='var(--red)';return;}

  const body={farm_id:currentFarmId};
  let msg='';

  if(mac){
    body.macs=mac.split(',').map(m=>m.trim()).filter(Boolean);
  }
  if(ip){
    const ips=expandIPRange(ip);
    if(ips.length===0){alert('Invalid IP format');return;}
    body.ips=ips;
  }

  if(body.ips && body.macs){
    msg=`Scanning ${body.ips.length} IP${body.ips.length>1?'s':''} and matching against MAC ${mac}...`;
  } else if(body.macs){
    msg=`Resolving MAC ${mac} via ARP cache...`;
  } else {
    msg=`Scanning ${body.ips.length} IP${body.ips.length>1?'s':''} for Sonoff sensors...`;
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
      status.textContent = (body.ips && body.macs)
        ? '✓ Scanning range and verifying MAC — check back in 20-30s'
        : body.macs
          ? '✓ Sent to agent — resolving MAC via ARP. Check back in 10s.'
          : '✓ Scanning started — readings appear when sensors are found.';
      status.style.color='var(--green)';
      setTimeout(function(){ if(currentFarmId) fetchSensorFromBackend(currentFarmId); }, 20000);
      setTimeout(function(){ if(currentFarmId) fetchSensorFromBackend(currentFarmId); }, 60000);
      setTimeout(function(){ if(currentFarmId) fetchSensorFromBackend(currentFarmId); }, 120000);
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
    appid:       document.getElementById('ewAppId')?.value.trim() || '',
    secret:      document.getElementById('ewSecret')?.value.trim() || '',
    redirectUrl: document.getElementById('ewRedirectUrl')?.value.trim() || '',
  };
  if(!cfg.appid || !cfg.secret || !cfg.redirectUrl){
    alert('App ID, App Secret, and Redirect URL are all required.\n\nGet the App ID/Secret from dev.ewelink.cc, and set Redirect URL to exactly match what you entered there when creating the app.');
    return null;
  }
  return fetch(API_BASE+'/api/sensors/config',{
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':'Bearer '+(localStorage.getItem('ekl_token')||'')},
    body:JSON.stringify(cfg)
  }).then(r=>r.json());
}

function connectEwelink(){
  const status = document.getElementById('ewStatus');
  status.textContent = 'Saving settings...';
  const saved = saveEwelinkConfig();
  if(!saved) return; // validation failed, alert already shown

  saved.then(()=>{
    status.textContent = 'Redirecting to eWeLink login...';
    return fetch(API_BASE+'/api/sensors/ewelink/authorize-url', {
      headers:{'Authorization':'Bearer '+(localStorage.getItem('ekl_token')||'')}
    });
  })
  .then(r=>r.json())
  .then(d=>{
    if(d.ok && d.url){
      // Remember we're mid-connection so we can pick up the pieces
      // when eWeLink sends the browser back to us with a code
      sessionStorage.setItem('ewelink_connecting', 'true');
      window.location.href = d.url;
    } else {
      status.innerHTML = '<span style="color:var(--red)">✗ '+(d.error||'Could not start login')+'</span>';
    }
  })
  .catch(e=>{ status.innerHTML='<span style="color:var(--red)">✗ '+e.message+'</span>'; });
}

// Called once, on app load — checks whether eWeLink just sent us back
// with a one-time code after the user logged in on their own page
function handleEwelinkCallback(){
  const params = new URLSearchParams(window.location.search);
  const code   = params.get('code');
  const region = params.get('region');
  if(!code) return;

  // Clean the code out of the URL immediately so refreshing the page
  // doesn't try to reuse an already-spent one-time code
  const cleanUrl = window.location.origin + window.location.pathname;
  window.history.replaceState({}, document.title, cleanUrl);

  const token = localStorage.getItem('ekl_token');
  if(!token) return; // not logged into Ekalavya yet — can't complete this

  toast('Finishing eWeLink connection...', 'var(--cyan)');
  fetch(API_BASE+'/api/sensors/ewelink/exchange', {
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
    body: JSON.stringify({ code, region })
  })
  .then(r=>r.json())
  .then(d=>{
    sessionStorage.removeItem('ewelink_connecting');
    if(d.ok){
      toast('✓ eWeLink connected — ' + d.devices + ' devices found', 'var(--green)');
      const badge = document.getElementById('ewConnBadge');
      if(badge){ badge.textContent='Connected'; badge.style.background='rgba(0,255,157,.15)'; badge.style.color='var(--green)'; }
      if (document.getElementById('ewDeviceList')) fetchEwelinkDevices();
    } else {
      toast('✗ eWeLink connection failed: ' + d.error, 'var(--red)');
    }
  })
  .catch(e=>{ toast('✗ ' + e.message, 'var(--red)'); });
}

function fetchEwelinkDevices(){
  document.getElementById('ewStatus').textContent = 'Fetching devices...';
  fetch(API_BASE+'/api/sensors/devices',{headers:{'Authorization':'Bearer '+(localStorage.getItem('ekl_token')||'')}})
  .then(r=>r.json())
  .then(d=>{
    if(d.error){
      document.getElementById('ewStatus').innerHTML = '<span style="color:var(--red)">✗ '+d.error+'</span>';
      return;
    }
    if(d.devices){
      document.getElementById('ewStatus').innerHTML = '<span style="color:var(--green)">✓ '+d.devices.length+' devices</span>';
      const badge = document.getElementById('ewConnBadge');
      if(badge){ badge.textContent='Connected'; badge.style.background='rgba(0,255,157,.15)'; badge.style.color='var(--green)'; }

      if(d.devices.length > 0){
        document.getElementById('ewDeviceList').innerHTML = '<div style="margin-top:10px"><div style="font-size:10px;color:var(--mute);margin-bottom:8px;text-transform:uppercase;letter-spacing:1px">Assign sensors to farms:</div>'+
          d.devices.map(function(dev){
            const p = dev.params || {};
            const temp = p.currentTemperature, hum = p.currentHumidity;
            return '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--b1)">'
              + '<div style="flex:1"><div style="font-size:12px;font-family:\'Exo 2\',sans-serif;font-weight:600">' + (dev.name||dev.deviceid) + '</div>'
              + '<div style="font-size:10px;color:var(--mute)">' + (dev.online?'&#x1F7E2; Online':'&#x26AB; Offline') + (temp!=null?' &middot; '+temp+'°C':'') + (hum!=null?' &middot; '+hum+'%':'') + '</div></div>'
              + '<select style="background:var(--bg);border:1px solid var(--b1);border-radius:4px;padding:4px 8px;color:var(--txt);font-size:11px" id="assign_' + dev.deviceid + '">'
              +   '<option value="">— No farm —</option>'
              +   agents.map(function(a){ return '<option value="'+a.id+'">'+a.name+'</option>'; }).join('')
              + '</select>'
              + '<button class="abtn" onclick="assignSensor(\'' + dev.deviceid + '\')">Assign</button>'
              + '</div>';
          }).join('')+'</div>';
      } else {
        document.getElementById('ewDeviceList').innerHTML = '<div style="font-size:11px;color:var(--mute);margin-top:8px">No devices found on this eWeLink account.</div>';
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
function liveUpdate(){if(isCustomer){ fetchMarketData(function(){ try{ renderPortal(); }catch(e){} }); renderPortal(); }}

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
  updateMergeSelBtn();
}
// Merge only ever makes sense for exactly two records — "keep" needs
// exactly one other candidate to compare against — so the button only
// appears once the selection is precisely that.
function updateMergeSelBtn(){
  const btn = document.getElementById('mergeSelBtn');
  if (!btn) return;
  const n = document.querySelectorAll('.worker-check:checked').length;
  btn.style.display = n === 2 ? '' : 'none';
}
function applyPreset(url, user){
  const u = document.getElementById('poolUrl'); if(u) u.value = url;
  const w = document.getElementById('poolUser'); if(w) w.value = user || '';
}
// ── Worker table filter + search ────────────────────────────
let workerFilter = 'all';

function setWF(val, btnEl){
  workerFilter = val;
  document.querySelectorAll('.fbtn').forEach(function(b){ b.classList.remove('active'); });
  if (btnEl) btnEl.classList.add('active');
  _workersHash = ''; // force rebuild
  renderWorkers();
}

// ── Low hashing ──────────────────────────────────────────────────
// Same rule as the backend's underperformer report (insights.js), so the
// two never disagree: a running machine is "low" when it hashes 15% or
// more below the MEDIAN of the same model across the fleet right now.
// Compared only within a model with at least 3 machines running — below
// that there's no trustworthy benchmark, so nothing is flagged.
// (LOW_HASH_PCT, LOW_HASH_MIN_COHORT and _hashBench are declared at the top of
// the file: the first render runs before this point is reached.)

function hashModelKey(w) {
  const raw = ((w.brand || '') + ' ' + (w.model || '')).toLowerCase();
  return raw.replace(/antminer|bitmain|whatsminer|microbt|avalon|canaan|sealminer|bitdeer/g, ' ')
            .replace(/[^a-z0-9]+/g, ' ').trim() || null;
}
function hashToTh(w) {
  const v = Number(w.hashrate) || 0;
  if (v <= 0) return 0;
  const u = String(w.hr_unit || 'TH/s').toUpperCase();
  return v * (u.indexOf('PH') === 0 ? 1e3 : u.indexOf('GH') === 0 ? 1e-3 : u.indexOf('MH') === 0 ? 1e-6 : 1);
}
function isRunning(w) {
  if (w.disabled) return false;
  const e = effectiveStatus(w);
  return e === 'online' || e === 'warn';
}
function computeHashBench() {
  const byModel = new Map();
  workers.forEach(function(w){
    if (!isRunning(w)) return;
    const k = hashModelKey(w), th = hashToTh(w);
    if (!k || th <= 0) return;
    if (!byModel.has(k)) byModel.set(k, []);
    byModel.get(k).push(th);
  });
  const bench = new Map();
  byModel.forEach(function(list, k){
    if (list.length < LOW_HASH_MIN_COHORT) return;
    list.sort(function(a, b){ return a - b; });
    const mid = Math.floor(list.length / 2);
    bench.set(k, list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2);
  });
  _hashBench = bench;
}
// { low, pct, median } for a running machine with a benchmark, else null
function hashHealth(w) {
  if (!isRunning(w)) return null;
  const med = _hashBench.get(hashModelKey(w));
  if (!med) return null;
  const pct = hashToTh(w) / med * 100;
  return { low: pct < 100 - LOW_HASH_PCT, pct: pct, median: med };
}
function isLowHash(w) { const h = hashHealth(w); return !!(h && h.low); }

function matchesWorkerFilter(w, filter){
  if (filter === 'all') return true;
  if (filter === 'low') return isLowHash(w);
  if (filter === 'disabled') return !!w.disabled;
  if (filter === 'sleeping') return w.status === 'sleeping';
  if (filter === 'warn')     return !w.disabled && w.status === 'warn';
  // A machine whose id still starts "w-ip-" never had a MAC or serial
  // captured, so it has no identity except its current IP — the exact
  // condition that produces a duplicate record instead of an update
  // the next time that IP changes.
  if (filter === 'noHwId')   return typeof w.id === 'string' && w.id.indexOf('w-ip-') === 0;
  // online/offline go through effectiveStatus so a machine whose agent
  // is down, or whose hashrate is 0, is correctly counted as offline here too
  // "Online" means running and hashing normally (green); running but
  // low has its own filter (yellow). A machine in 'warn' (hot, still
  // mining) is running, so it is no longer counted as offline.
  if (filter === 'online')  return isRunning(w) && !isLowHash(w);
  if (filter === 'offline') return !isRunning(w) && !w.disabled && w.status !== 'sleeping';
  return true;
}

function filterWorkersBySearch(list){
  const box = document.getElementById('wSearch');
  const q   = box ? box.value.trim().toLowerCase() : '';
  if (!q) return list;
  return list.filter(function(w){
    return (w.name  || '').toLowerCase().includes(q)
        || (w.ip    || '').toLowerCase().includes(q)
        || (w.model || '').toLowerCase().includes(q)
        || (w.brand || '').toLowerCase().includes(q)
        || (w.worker_id || '').toLowerCase().includes(q)
        || (w.serial || '').toLowerCase().includes(q)
        || (w.mac    || '').toLowerCase().includes(q);
  });
}

function onWorkerSearchInput(){
  _workersHash = '';
  renderWorkers();
}

// ── Filter by site / agent ──────────────────────────────────
// Independent of the status buttons, so "Ghummadh + Offline" works.
// (declaration moved to the top of the file — see the comment there)

// ── Per-miner hashrate & uptime history ─────────────────────
// Drawn straight from stored history on the backend (miner_metrics,
// one row per 10-minute slot), so it's the same data whoever looks
// at it and it doesn't reset when a tab closes.
let histState = { wid: null, hours: 168, points: [], hoverX: null };

// ── Site alarm setting (Settings page) ─────────────────────────────
// How many machines offline at one site trigger the alarm (phone call +
// Telegram). Stored on the server; the alarm picks a change up within
// one check (~3 min).
function siteAlarmStatusText(d) {
  return 'Calls when ' + d.alarm_at + '+ machines have been offline ' + (d.delay_min || 10) + '+ min. After a call: again only if 5 more go down, at most every '
    + (d.repeat_min || 60) + ' min; a fresh alarm once the site is back to ' + d.rearm_at + ' or fewer.';
}
function loadSiteAlarmSetting() {
  const st = document.getElementById('siteAlarmStatus');
  authFetch('/api/alerts/settings').then(function(d){
    if (!d || !d.ok) { if (st) st.textContent = 'Could not load the current setting.'; return; }
    const inp = document.getElementById('siteAlarmAt');
    if (inp && document.activeElement !== inp) inp.value = d.alarm_at;
    const dl = document.getElementById('siteAlarmDelay');
    if (dl && document.activeElement !== dl) dl.value = d.delay_min || 10;
    const rp = document.getElementById('siteAlarmRepeat');
    if (rp && document.activeElement !== rp) rp.value = d.repeat_min || 60;
    if (st) { st.style.color = 'var(--mute)'; st.textContent = siteAlarmStatusText(d); }
  });
}
function saveSiteAlarmSetting() {
  const inp = document.getElementById('siteAlarmAt');
  const st  = document.getElementById('siteAlarmStatus');
  const n   = parseInt(inp && inp.value, 10);
  const dl  = parseInt((document.getElementById('siteAlarmDelay') || {}).value, 10);
  const rp  = parseInt((document.getElementById('siteAlarmRepeat') || {}).value, 10);
  if (!(n >= 1 && n <= 1000)) { toast('Enter a whole number of machines between 1 and 1000', 'var(--warn)'); return; }
  if (!(dl >= 1 && dl <= 240)) { toast('Minutes offline: 1 to 240', 'var(--warn)'); return; }
  if (!(rp >= 5 && rp <= 1440)) { toast('Minutes between calls: 5 to 1440', 'var(--warn)'); return; }
  const token = localStorage.getItem('ekl_token') || '';
  fetch(API_BASE + '/api/alerts/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ alarm_at: n, delay_min: dl, repeat_min: rp })
  })
  .then(function(r){ return r.json().catch(function(){ return { ok: false, error: 'HTTP ' + r.status }; })
    .then(function(d){ if (r.status === 403) d = { ok: false, error: 'Only an admin or manager can change this' }; return d; }); })
  .then(function(d){
    if (!d || !d.ok) { toast('✗ ' + ((d && d.error) || 'Could not save'), 'var(--red)'); return; }
    if (st) { st.style.color = 'var(--green)'; st.textContent = '✓ Saved. ' + siteAlarmStatusText(d); }
    toast('✓ Site alarm: ' + d.alarm_at + '+ machines offline for ' + d.delay_min + '+ min', 'var(--green)');
  })
  .catch(function(e){ toast('✗ ' + e.message, 'var(--red)'); });
}

// ── Auto-restart (Settings page) ────────────────────────────────────
function renderAutoRestart(d) {
  const en = document.getElementById('arEnabled'), mi = document.getElementById('arMinutes'), mx = document.getElementById('arMax');
  if (en) en.checked = !!d.enabled;
  if (mi && document.activeElement !== mi) mi.value = d.minutes;
  if (mx && document.activeElement !== mx) mx.value = d.max_per_day;
  const b = document.getElementById('arBadge');
  if (b) { b.textContent = d.enabled ? 'On' : 'Off'; b.className = 'badge ' + (d.enabled ? 'bgn' : ''); }
  const st = document.getElementById('arStatus');
  if (st) {
    st.style.color = 'var(--mute)';
    st.textContent = d.enabled
      ? 'On — rebooted after ' + d.minutes + ' min at 0 hashrate, at most ' + d.max_per_day + ' restarts, then left for a person until it hashes again for 1 h.'
      : 'Off — machines with their own setting still follow it.';
  }
  arDefault = { enabled: !!d.enabled, minutes: d.minutes, max_per_day: d.max_per_day };
  renderArMachines(d.machines);
  const lg = document.getElementById('arLog');
  if (lg) {
    const rows = (d.log || []).slice(0, 10);
    const col = { restarted: 'var(--green)', failed: 'var(--red)', 'gave-up': 'var(--warn)', 'skipped-site': 'var(--orange)', 'log-sent': 'var(--cyan)' };
    const word = { restarted: 'Restarted', failed: 'Failed', 'gave-up': 'Left for a person', 'skipped-site': 'Site-wide — not restarted', 'log-sent': 'Log sent' };
    lg.innerHTML = rows.length
      ? '<div style="font-size:11px;color:var(--mute);margin-bottom:6px">Recent automatic actions</div>'
        + rows.map(function(r){
            return '<div style="display:flex;gap:10px;font-size:11.5px;padding:5px 0;border-top:1px solid var(--b1)">'
              + '<span style="color:var(--mute);white-space:nowrap">' + escHtml(new Date(r.at).toLocaleString()) + '</span>'
              + '<span style="color:' + (col[r.action] || 'var(--txt)') + ';white-space:nowrap">' + escHtml(word[r.action] || r.action) + '</span>'
              + '<span>' + escHtml([r.site, r.machine].filter(Boolean).join(' · ')) + ' <span style="color:var(--mute)">' + escHtml(r.detail || '') + '</span></span></div>';
          }).join('')
      : '';
  }
}
function loadAutoRestart() {
  authFetch('/api/alerts/auto-restart').then(function(d){
    if (!d || !d.ok) { const st = document.getElementById('arStatus'); if (st) st.textContent = 'Could not load the current setting.'; return; }
    renderAutoRestart(d);
  });
}
function saveAutoRestart() {
  const en = document.getElementById('arEnabled'), mi = document.getElementById('arMinutes'), mx = document.getElementById('arMax');
  const body = { enabled: !!(en && en.checked), minutes: parseInt(mi && mi.value, 10), max_per_day: parseInt(mx && mx.value, 10) };
  if (!(body.minutes >= 5 && body.minutes <= 1440)) { toast('Minutes must be between 5 and 1440', 'var(--warn)'); return; }
  if (!(body.max_per_day >= 1 && body.max_per_day <= 20)) { toast('Restarts must be between 1 and 20', 'var(--warn)'); return; }
  if (body.enabled && !confirm('Machines at 0 hashrate for ' + body.minutes + ' minutes will be rebooted automatically (at most '
      + body.max_per_day + ' times each, then left for a person). Switch this on?')) return;
  const token = localStorage.getItem('ekl_token') || '';
  fetch(API_BASE + '/api/alerts/auto-restart', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify(body)
  })
  .then(function(r){ return r.json().catch(function(){ return { ok: false, error: 'HTTP ' + r.status }; })
    .then(function(d){ if (r.status === 403) d = { ok: false, error: 'Only an admin or manager can change this' }; return d; }); })
  .then(function(d){
    if (!d || !d.ok) { toast('✗ ' + ((d && d.error) || 'Could not save'), 'var(--red)'); return; }
    renderAutoRestart(d);
    toast('✓ Auto-restart ' + (d.enabled ? 'on — ' + d.minutes + ' min at 0 hashrate' : 'off'), 'var(--green)');
  })
  .catch(function(e){ toast('✗ ' + e.message, 'var(--red)'); });
}

// ── Telegram alert rules (Settings page) ───────────────────────────
// What goes to the group: site alarm (fixed), overheating, hashrate drop,
// back-to-normal, auto-restart log / paused, daily summary.
function tgSet(id, v) { const el = document.getElementById(id); if (!el) return; if (el.type === 'checkbox') el.checked = !!v; else if (document.activeElement !== el) el.value = v; }
function tgDim() {
  document.querySelectorAll('#tgRulesPanel .tg-row:not(.tg-fixed)').forEach(function(r){
    const t = r.querySelector('input[type=checkbox]'); r.classList.toggle('off', !!t && !t.checked);
  });
}
function renderTgRules(d) {
  const r = d.rules || {};
  tgSet('tgOh', r.overheat && r.overheat.on); tgSet('tgOhTemp', r.overheat && r.overheat.temp); tgSet('tgOhMin', r.overheat && r.overheat.min);
  tgSet('tgHd', r.hashdrop && r.hashdrop.on); tgSet('tgHdPct', r.hashdrop && r.hashdrop.pct);
  tgSet('tgRec', r.recovery && r.recovery.on);
  tgSet('tgArLog', r.autorestart_log && r.autorestart_log.on);
  tgSet('tgArPause', r.autorestart_paused && r.autorestart_paused.on);
  tgSet('tgSum', r.summary && r.summary.on); tgSet('tgSumTime', r.summary && r.summary.time);
  const a = document.getElementById('tgAlarmAt'); if (a && d.alarm_at) a.textContent = d.alarm_at;
  const b = document.getElementById('tgBadge');
  if (b) { b.textContent = d.telegram ? 'Connected' : 'Not set up'; b.className = 'badge ' + (d.telegram ? 'bgn' : 'brn'); }
  const st = document.getElementById('tgStatus');
  if (st && !d.telegram) { st.style.color = 'var(--warn)'; st.textContent = 'Telegram isn\'t set up on the server — add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in Railway.'; }
  tgDim();
}
function loadTgRules() {
  authFetch('/api/alerts/telegram-rules').then(function(d){
    if (!d || !d.ok || !d.rules) { const b = document.getElementById('tgBadge'); if (b) b.textContent = '—'; return; }
    renderTgRules(d);
  });
}
function tgPost(path, body) {
  const token = localStorage.getItem('ekl_token') || '';
  return fetch(API_BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify(body || {}) })
    .then(function(r){ return r.json().catch(function(){ return { ok: false, error: 'HTTP ' + r.status }; })
      .then(function(d){ if (r.status === 403) d = { ok: false, error: 'Only an admin or manager can change this' }; return d; }); });
}
function saveTgRules() {
  const v = function(id){ const el = document.getElementById(id); return el ? el.value : ''; };
  const c = function(id){ const el = document.getElementById(id); return !!(el && el.checked); };
  const body = {
    overheat: { on: c('tgOh'), temp: parseInt(v('tgOhTemp'), 10), min: parseInt(v('tgOhMin'), 10) },
    hashdrop: { on: c('tgHd'), pct: parseInt(v('tgHdPct'), 10) },
    recovery: { on: c('tgRec') },
    autorestart_log: { on: c('tgArLog') },
    autorestart_paused: { on: c('tgArPause') },
    summary: { on: c('tgSum'), time: v('tgSumTime') || '09:00' },
  };
  if (!(body.overheat.temp >= 50 && body.overheat.temp <= 150)) { toast('Overheating temperature: 50 to 150 °C', 'var(--warn)'); return; }
  if (!(body.overheat.min >= 1)) { toast('Overheating: at least 1 machine', 'var(--warn)'); return; }
  if (!(body.hashdrop.pct >= 5 && body.hashdrop.pct <= 90)) { toast('Hashrate drop: 5 to 90 %', 'var(--warn)'); return; }
  const btn = document.getElementById('tgSave'); if (btn) btn.disabled = true;
  tgPost('/api/alerts/telegram-rules', body).then(function(d){
    if (!d || !d.ok) { toast('✗ ' + ((d && d.error) || 'Could not save'), 'var(--red)'); return; }
    renderTgRules(d);
    const st = document.getElementById('tgStatus'); if (st && d.telegram) { st.style.color = 'var(--green)'; st.textContent = '✓ Saved.'; }
    toast('✓ Telegram alerts saved', 'var(--green)');
  }).catch(function(e){ toast('✗ ' + e.message, 'var(--red)'); })
    .then(function(){ if (btn) btn.disabled = false; });
}
function sendTgTest() {
  const btn = document.getElementById('tgTest'); if (btn) btn.disabled = true;
  tgPost('/api/alerts/telegram-rules/test').then(function(d){
    if (!d || !d.ok) { toast('✗ ' + ((d && d.error) || 'Could not send'), 'var(--red)'); return; }
    toast('✓ Test message sent to the Telegram group', 'var(--green)');
  }).catch(function(e){ toast('✗ ' + e.message, 'var(--red)'); })
    .then(function(){ if (btn) btn.disabled = false; });
}
document.addEventListener('change', function(e){ if (e.target && e.target.closest && e.target.closest('#tgRulesPanel') && e.target.type === 'checkbox') tgDim(); });

// ── Log checks (Settings page) ──────────────────────────────────────
// Known error lines in a miner's log + the miner's own fan / chip numbers
// → short messages under the log post in Telegram. No AI. Rules can be
// switched off or added; "Check machine" / "Paste a log" try them without
// sending anything.
let lcRules = null;                 // { builtin:[…], custom:[…] } as last loaded
let lcDraft = null;                 // being edited in the rules sheet
function lcPost(path, body) {
  const token = localStorage.getItem('ekl_token') || '';
  return fetch(API_BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify(body) })
    .then(function(r){ return r.json().catch(function(){ return { ok: false, error: 'HTTP ' + r.status }; })
      .then(function(d){ if (r.status === 403) d = { ok: false, error: 'Only an admin or manager can change this' }; return d; }); });
}
function lcBadge() {
  const b = document.getElementById('lcBadge'); if (!b || !lcRules) return;
  const on = lcRules.builtin.filter(function(r){ return r.enabled; }).length + lcRules.custom.filter(function(r){ return r.enabled !== false; }).length;
  b.textContent = on + ' rules' + (lcRules.custom.length ? ' · ' + lcRules.custom.length + ' yours' : '');
  b.className = 'badge bgn';
}
function lcFillMachines() {
  const dl = document.getElementById('lcMachineList'); if (!dl || typeof workers === 'undefined') return;
  dl.innerHTML = workers.filter(function(w){ return w && w.ip; }).slice(0, 3000).map(function(w){
    return '<option value="' + escHtml((w.name || w.ip) + ' — ' + w.ip + (w.farm ? ' — ' + w.farm : '')) + '"></option>';
  }).join('');
}
function loadLogRules() {
  lcFillMachines();
  authFetch('/api/alerts/log-rules').then(function(d){
    if (!d || !d.ok || !Array.isArray(d.builtin)) { const b = document.getElementById('lcBadge'); if (b) b.textContent = '—'; return; }
    lcRules = { builtin: d.builtin, custom: Array.isArray(d.custom) ? d.custom : [] }; lcBadge();
  });
}
function lcFindMachine(v) {
  v = String(v || '').trim(); if (!v) return null;
  const ipm = v.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
  const byIp = ipm ? workers.filter(function(w){ return w.ip === ipm[0]; }) : [];
  if (byIp.length === 1) return byIp[0];
  const name = v.split(' — ')[0].toLowerCase();
  const hits = (byIp.length ? byIp : workers).filter(function(w){ return String(w.name || '').toLowerCase() === name; });
  return hits.length === 1 ? hits[0] : (byIp[0] || hits[0] || null);
}
function lcShow(d, what) {
  const el = document.getElementById('lcResult'); if (!el) return;
  if (!d || !d.ok) { el.style.color = 'var(--red)'; el.textContent = '✗ ' + ((d && d.error) || 'Could not check'); return; }
  el.style.color = 'var(--txt)';
  const f = d.findings || [];
  const snap = d.snapshot;
  let nums = '';
  if (snap && ((snap.fans && snap.fans.length) || (snap.chains && snap.chains.length))) {
    nums = '<div style="font-size:11px;color:var(--mute);margin-top:6px">'
      + (snap.fans && snap.fans.length ? 'Fans (RPM): ' + snap.fans.map(function(v, i){ return (i + 1) + '=' + (v === null ? '—' : v); }).join('  ') : '')
      + (snap.chains && snap.chains.length ? (snap.fans && snap.fans.length ? ' · ' : '') + 'Chips: ' + snap.chains.map(function(c){ return 'chain ' + c.index + '=' + (c.asic === null || c.asic === undefined ? '—' : c.asic); }).join('  ') : '')
      + '</div>';
  } else if (what === 'machine') {
    nums = '<div style="font-size:11px;color:var(--mute);margin-top:6px">No fan / chip numbers from this machine (agent older than v1.1.45, or the miner doesn\'t report them) &mdash; log lines only.</div>';
  }
  el.innerHTML = '<div style="font-size:11px;color:var(--mute);margin:8px 0 4px">' + escHtml((what === 'machine' && d.machine ? (d.machine.name || d.machine.ip) + ' (' + d.machine.ip + ') · ' : '') + d.lines + ' log lines checked')
    + (what === 'machine' && d.log_tail ? ' · <a href="#" onclick="lcDownloadLog();return false">download log</a>' : '') + '</div>'
    + (f.length ? f.map(function(x){
        return '<div class="lc-find"><span class="lc-dot" style="background:' + (x.level === 'error' ? 'var(--red)' : 'var(--warn)') + '"></span>'
          + escHtml(x.text) + (x.count > 1 ? ' <span style="color:var(--mute)">×' + x.count + '</span>' : '')
          + ' <span style="color:var(--mute);font-size:11px">' + escHtml(x.source || '') + '</span>'
          + (x.evidence ? '<span class="lc-ev">' + escHtml(x.evidence) + '</span>' : '') + '</div>';
      }).join('')
      : '<div class="lc-find" style="color:var(--mute)">No known error found. If this log does show a problem, add a rule for it under Rules.</div>')
    + nums;
  lcLast = d;
}
let lcLast = null;
function lcDownloadLog() {
  if (!lcLast || !lcLast.log_tail) return;
  const m = lcLast.machine || {};
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lcLast.log_tail], { type: 'text/plain' }));
  a.download = ((m.name || m.ip || 'miner') + '_log.txt').replace(/[^A-Za-z0-9._-]+/g, '_');
  document.body.appendChild(a); a.click(); setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
function logCheckMachine() {
  const inp = document.getElementById('lcMachine');
  const w = lcFindMachine(inp && inp.value);
  if (!w) { toast('Choose a machine from the list (name or IP)', 'var(--warn)'); return; }
  const btn = document.getElementById('lcCheckBtn'), el = document.getElementById('lcResult');
  if (btn) btn.disabled = true;
  if (el) { el.style.color = 'var(--mute)'; el.textContent = 'Reading the log from ' + (w.name || w.ip) + '…'; }
  lcPost('/api/alerts/log-rules/test', { worker_id: w.id })
    .then(function(d){ lcShow(d, 'machine'); })
    .catch(function(e){ lcShow({ ok: false, error: e.message }); })
    .then(function(){ if (btn) btn.disabled = false; });
}
function toggleLogPaste() {
  const b = document.getElementById('lcPasteBox'); if (!b) return;
  b.style.display = b.style.display === 'none' ? '' : 'none';
  if (b.style.display === '') { const t = document.getElementById('lcPaste'); if (t) t.focus(); }
}
function logCheckPaste() {
  const t = document.getElementById('lcPaste');
  if (!t || !t.value.trim()) { toast('Paste a log first', 'var(--warn)'); return; }
  lcPost('/api/alerts/log-rules/test', { log: t.value }).then(function(d){ lcShow(d, 'paste'); })
    .catch(function(e){ lcShow({ ok: false, error: e.message }); });
}
function openLogRules() {
  const go = function(){
    lcDraft = { builtin: lcRules.builtin.map(function(r){ return Object.assign({}, r); }), custom: lcRules.custom.map(function(r){ return Object.assign({}, r); }) };
    renderLogRules(); openSheet('logRulesSheet');
  };
  if (lcRules) go();
  else authFetch('/api/alerts/log-rules').then(function(d){ if (d && d.ok && Array.isArray(d.builtin)) { lcRules = { builtin: d.builtin, custom: d.custom }; lcBadge(); go(); } else toast('✗ Could not load the rules', 'var(--red)'); });
}
function renderLogRules() {
  const cl = document.getElementById('lcCustomList'), bl = document.getElementById('lcBuiltinList');
  if (!lcDraft) return;
  const tog = function(kind, i, on){ return '<label class="toggle" title="On / off"><input type="checkbox"' + (on ? ' checked' : '') + ' onchange="lcToggle(\'' + kind + '\',' + i + ',this.checked)"><span class="tsldr"></span></label>'; };
  if (cl) cl.innerHTML = lcDraft.custom.length ? lcDraft.custom.map(function(r, i){
      return '<div class="lc-row' + (r.enabled === false ? ' off' : '') + '">' + tog('custom', i, r.enabled !== false)
        + '<div class="lc-msg">' + (r.level === 'warn' ? '<span class="lc-dot" style="background:var(--warn)"></span>' : '<span class="lc-dot" style="background:var(--red)"></span>') + escHtml(r.message)
        + '<span class="lc-pat">' + escHtml(r.pattern) + '</span></div>'
        + '<button class="btn btn-sm btn-ghost" type="button" title="Delete" onclick="lcDelete(' + i + ')"><svg class="ic sm"><use href="#i-trash"/></svg></button></div>';
    }).join('') : '<div style="font-size:12px;color:var(--mute);padding:4px 0 2px">None yet.</div>';
  if (bl) bl.innerHTML = lcDraft.builtin.map(function(r, i){
      return '<div class="lc-row' + (r.enabled ? '' : ' off') + '">' + tog('builtin', i, r.enabled)
        + '<div class="lc-msg"><span class="lc-dot" style="background:' + (r.level === 'error' ? 'var(--red)' : 'var(--warn)') + '"></span>' + escHtml(r.message)
        + '<span class="lc-pat" title="' + escHtml(r.pattern) + '">' + escHtml(r.pattern) + '</span></div></div>';
    }).join('');
}
function lcToggle(kind, i, on) { const r = lcDraft && lcDraft[kind][i]; if (!r) return; r.enabled = !!on; renderLogRules(); }
function lcDelete(i) { if (!lcDraft) return; lcDraft.custom.splice(i, 1); renderLogRules(); }
function addLogRule() {
  const p = document.getElementById('lcNewPattern'), m = document.getElementById('lcNewMessage'), l = document.getElementById('lcNewLevel');
  const pattern = (p && p.value || '').trim(), message = (m && m.value || '').trim();
  if (!pattern || !message) { toast('Fill in both: the text in the log and the message', 'var(--warn)'); return; }
  const rx = pattern.match(/^\/(.+)\/[a-z]*$/i);
  if (rx) { try { new RegExp(rx[1], 'i'); } catch (e) { toast('Not a valid pattern: ' + e.message, 'var(--warn)'); return; } }
  lcDraft.custom.push({ pattern: pattern, message: message, level: (l && l.value) === 'warn' ? 'warn' : 'error', enabled: true });
  p.value = ''; m.value = '';
  renderLogRules();
}
function saveLogRules() {
  if (!lcDraft) return;
  const p = document.getElementById('lcNewPattern'), m = document.getElementById('lcNewMessage');
  if (p && m && (p.value.trim() || m.value.trim())) { toast('Press Add for the new rule first (or clear it)', 'var(--warn)'); return; }
  const body = { disabled: lcDraft.builtin.filter(function(r){ return !r.enabled; }).map(function(r){ return r.id; }), custom: lcDraft.custom };
  const btn = document.getElementById('lcSaveBtn'); if (btn) btn.disabled = true;
  lcPost('/api/alerts/log-rules', body).then(function(d){
    if (!d || !d.ok) { toast('✗ ' + ((d && d.error) || 'Could not save'), 'var(--red)'); return; }
    lcRules = { builtin: d.builtin, custom: d.custom }; lcBadge();
    closeSheet('logRulesSheet');
    toast('✓ Log check rules saved', 'var(--green)');
  }).catch(function(e){ toast('✗ ' + e.message, 'var(--red)'); })
    .then(function(){ if (btn) btn.disabled = false; });
}

// ── Auto-restart per machine (machine page + bulk on the Workers page) ──
// Each machine can follow the default above, be off (e.g. hydro machines),
// or have its own minutes / daily limit. Stored on the server by MAC.
let arDefault = null;          // { enabled, minutes, max_per_day } — last seen default
let arMachineWid = null;       // machine the panel section was loaded for
function arDefaultText() {
  if (!arDefault) return 'the default on the Settings page';
  return arDefault.enabled
    ? 'the default: ON — restart after ' + arDefault.minutes + ' min at 0 hashrate, at most ' + arDefault.max_per_day + ' restarts'
    : 'the default: OFF — not restarted automatically';
}
function arPickMode(p, mode) {
  const seg = document.getElementById(p + 'Mode');
  if (seg) seg.querySelectorAll('.fbtn').forEach(function(b){ b.classList.toggle('active', b.getAttribute('data-mode') === mode); });
  if (seg) seg.setAttribute('data-value', mode);
  const own = document.getElementById(p + 'Own'); if (own) own.style.display = mode === 'on' ? '' : 'none';
  const mi = document.getElementById(p + 'Minutes'), mx = document.getElementById(p + 'Max');
  if (mode === 'on' && arDefault) {
    if (mi && !mi.value) mi.value = arDefault.minutes;
    if (mx && !mx.value) mx.value = arDefault.max_per_day;
  }
  const h = document.getElementById(p + 'Hint');
  if (h) h.textContent = mode === 'default' ? 'Follows ' + arDefaultText() + '.'
    : mode === 'off' ? 'Never restarted automatically, whatever the default is. Use this for hydro machines or any machine that must not reboot on its own.'
    : mode === 'on' ? 'Restarted after the minutes below at 0 hashrate, even while the default is off. Machines in repair or asleep are still never touched.'
    : 'Choose a setting.';
}
function arReadForm(p) {
  const seg = document.getElementById(p + 'Mode');
  const mode = seg && seg.getAttribute('data-value');
  if (!mode) { toast('Choose Follow default, Off or Own setting', 'var(--warn)'); return null; }
  const body = { mode: mode };
  if (mode === 'on') {
    body.minutes = parseInt((document.getElementById(p + 'Minutes') || {}).value, 10);
    body.max_per_day = parseInt((document.getElementById(p + 'Max') || {}).value, 10);
    if (!(body.minutes >= 5 && body.minutes <= 1440)) { toast('Minutes must be between 5 and 1440', 'var(--warn)'); return null; }
    if (!(body.max_per_day >= 1 && body.max_per_day <= 20)) { toast('Restarts must be between 1 and 20', 'var(--warn)'); return null; }
  }
  return body;
}
function postAutoRestartMachines(ids, body) {
  const token = localStorage.getItem('ekl_token') || '';
  return fetch(API_BASE + '/api/alerts/auto-restart/machines', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify(Object.assign({ worker_ids: ids }, body))
  })
  .then(function(r){ return r.json().catch(function(){ return { ok: false, error: 'HTTP ' + r.status }; })
    .then(function(d){ if (r.status === 403) d = { ok: false, error: 'Only an admin or manager can change this' }; return d; }); });
}
function arModeWords(b) {
  return b.mode === 'default' ? 'follows the default' : b.mode === 'off' ? 'auto-restart OFF'
    : 'own setting: ' + b.minutes + ' min, max ' + b.max_per_day + ' restarts';
}

function loadMachineAutoRestart(wid) {
  arMachineWid = wid;
  const badge = document.getElementById('ctrlArBadge'), info = document.getElementById('ctrlArInfo');
  if (badge) { badge.textContent = '…'; badge.className = 'badge'; }
  if (info) info.textContent = '';
  ['ctrlArMinutes', 'ctrlArMax'].forEach(function(id){ const el = document.getElementById(id); if (el) el.value = ''; });
  authFetch('/api/alerts/auto-restart/machine/' + encodeURIComponent(wid)).then(function(d){
    if (arMachineWid !== wid) return;                 // another machine opened meanwhile
    if (!d || !d.ok) { arPickMode('ctrlAr', ''); if (info) info.textContent = 'Could not load this machine\'s auto-restart setting.'; return; }
    arDefault = d.default;
    const mi = document.getElementById('ctrlArMinutes'), mx = document.getElementById('ctrlArMax');
    if (mi) mi.value = d.minutes; if (mx) mx.value = d.max_per_day;
    arPickMode('ctrlAr', d.mode);
    if (badge) {
      badge.textContent = d.mode === 'off' ? 'Off' : d.mode === 'on' ? 'On · own' : (d.active ? 'On · default' : 'Off · default');
      badge.className = 'badge ' + (d.active ? 'bgn' : '');
    }
    const bits = [];
    if (d.zero_minutes !== null && d.zero_minutes !== undefined) bits.push('At 0 hashrate for ' + d.zero_minutes + ' min now');
    const used = (d.restarts !== undefined ? d.restarts : d.restarts_today) || 0;
    bits.push(d.left_for_person ? used + ' automatic restarts used — left for a person until it hashes again for 1 h'
      : used + ' of ' + d.max_per_day + ' automatic restarts used');
    if (d.mode !== 'default' && d.set_at) bits.push('set by ' + (d.set_by || '?') + ' on ' + new Date(d.set_at).toLocaleString());
    if (info) info.textContent = bits.join(' · ');
  });
}
function saveMachineAutoRestart() {
  const w = workers.find(function(x){ return x.id === activeWid; });
  if (!w) { toast('No miner selected', 'var(--warn)'); return; }
  const body = arReadForm('ctrlAr'); if (!body) return;
  postAutoRestartMachines([w.id], body).then(function(d){
    if (!d || !d.ok) { toast('✗ ' + ((d && d.error) || 'Could not save'), 'var(--red)'); return; }
    toast('✓ ' + w.name + ': ' + arModeWords(body), 'var(--green)');
    loadMachineAutoRestart(w.id);
  }).catch(function(e){ toast('✗ ' + e.message, 'var(--red)'); });
}

let arBulkIds = [];
function openBulkAutoRestart() {
  arBulkIds = Array.from(document.querySelectorAll('.worker-check:checked')).map(function(c){ return c.dataset.wid; });
  if (!arBulkIds.length) { toast('Tick the machines first (e.g. filter to one site, then tick all)', 'var(--warn)'); return; }
  const n = document.getElementById('bulkArCount'); if (n) n.textContent = arBulkIds.length;
  ['bulkArMinutes', 'bulkArMax'].forEach(function(id){ const el = document.getElementById(id); if (el) el.value = ''; });
  arPickMode('bulkAr', '');
  openSheet('arBulkSheet');
  authFetch('/api/alerts/auto-restart').then(function(d){
    if (d && d.ok) { arDefault = { enabled: !!d.enabled, minutes: d.minutes, max_per_day: d.max_per_day }; }
  });
}
function saveBulkAutoRestart() {
  const body = arReadForm('bulkAr'); if (!body) return;
  if (!arBulkIds.length) return;
  if (!confirm('Set ' + arBulkIds.length + ' machine(s) to: ' + arModeWords(body) + '?')) return;
  postAutoRestartMachines(arBulkIds, body).then(function(d){
    if (!d || !d.ok) { toast('✗ ' + ((d && d.error) || 'Could not save'), 'var(--red)'); return; }
    closeSheet('arBulkSheet');
    toast('✓ ' + d.updated + ' machine(s): ' + arModeWords(body) + (d.missing ? ' (' + d.missing + ' not found on the server)' : ''), 'var(--green)');
    renderArMachines(d.machines);
  }).catch(function(e){ toast('✗ ' + e.message, 'var(--red)'); });
}

// Settings card: machines that don't follow the default
function renderArMachines(list) {
  const el = document.getElementById('arMachines');
  if (!el || !Array.isArray(list)) return;
  if (!list.length) { el.innerHTML = ''; return; }
  const site = function(fid){ const a = (agents || []).find(function(x){ return x.id === fid; }); return a ? a.name : (fid || ''); };
  el.innerHTML = '<div style="font-size:11px;color:var(--mute);margin-bottom:6px">Machines with their own setting (' + list.length + ')</div>'
    + '<div style="max-height:260px;overflow-y:auto">'
    + list.map(function(m){
        const on = m.mode === 'on';
        return '<div style="display:flex;align-items:center;gap:10px;font-size:11.5px;padding:5px 0;border-top:1px solid var(--b1)">'
          + '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(m.name || m.ip || '')
          + ' <span style="color:var(--mute)">' + escHtml([site(m.farm_id), m.ip].filter(Boolean).join(' · ')) + '</span></span>'
          + '<span style="white-space:nowrap;color:' + (on ? 'var(--green)' : 'var(--warn)') + '">' + (on ? 'On · ' + m.minutes + ' min · max ' + m.max_per_day : 'Off') + '</span>'
          + '<button class="abtn" type="button" title="Follow the default again" onclick="arResetMachine(\'' + escAttr(m.worker_id) + '\')">Use default</button>'
          + '</div>';
      }).join('') + '</div>';
}
function arResetMachine(wid) {
  postAutoRestartMachines([wid], { mode: 'default' }).then(function(d){
    if (!d || !d.ok) { toast('✗ ' + ((d && d.error) || 'Could not save'), 'var(--red)'); return; }
    toast('✓ Back to the default', 'var(--green)');
    renderArMachines(d.machines);
  }).catch(function(e){ toast('✗ ' + e.message, 'var(--red)'); });
}

// ── Farms & agent PCs (Remote Access) ──────────────────────────────
// Which farm a PC runs, and each farm's name, are set here — not in the
// PC's .env. A PC the server hasn't seen waits under "New agents" until
// it's given a farm. See backend services/farms.js.
let farmsState = { farms: [], pending: [] };
let farmPick = null;   // { onOk, allowNew }

function loadFarms() {
  if (isCustomer) return;
  const pg = document.getElementById('page-agents');
  authFetch('/api/farms').then(function(d){
    if (!d || !d.ok) { const fl = document.getElementById('farmsList'); if (fl && !farmsState.farms.length) fl.innerHTML = '<div style="color:var(--mute);font-size:12px">Could not load farms.</div>'; return; }
    farmsState = { farms: d.farms || [], pending: d.pending || [], poll_sec: d.poll_sec || 30 };
    renderFarmsPanel(); renderPendingAgents();
  });
}
function farmById(id) { return farmsState.farms.find(function(f){ return f.farm_id === id; }); }
function farmLabel(f) { return f ? (f.name + (f.name !== f.farm_id ? '' : '')) : ''; }

function renderPendingAgents() {
  const panel = document.getElementById('pendingAgentsPanel'), grid = document.getElementById('pendingAgentsGrid');
  const n = farmsState.pending.length;
  if (panel) panel.style.display = n ? '' : 'none';
  const b = document.getElementById('pendingAgentsBadge'); if (b) b.textContent = n;
  if (!grid) return;
  grid.innerHTML = farmsState.pending.map(function(p){
    const sug = p.suggested_farm_id && farmById(p.suggested_farm_id);
    return '<div class="pend"><span class="sdot on"></span><b>' + escHtml(p.hostname || 'Unknown PC') + '</b>'
      + '<span class="mono">' + escHtml([(p.ips || []).join(', '), (p.subnets || []).join(', ')].filter(Boolean).join(' · ')) + '</span>'
      + (sug ? '<span class="chip ok">looks like ' + escHtml(sug.name) + '</span>' : '')
      + (p.key_ok ? '' : '<span class="chip warn">key differs<span class="tip" tabindex="0" data-tip="This PC&rsquo;s agent key doesn&rsquo;t match the server&rsquo;s AGENT_KEYS. Only assign it if you know this PC.">i</span></span>')
      + '<button class="abtn active" type="button" onclick="assignPendingPc(\'' + escAttr(p.pc_id) + '\')">Choose farm</button></div>';
  }).join('');
}

function renderRaSummary() {
  const el = document.getElementById('raSummary'); if (!el) return;
  const farms = farmsState.farms;
  const pcsOn = farms.reduce(function(n, f){ return n + (f.pcs || []).filter(function(p){ return p.online; }).length; }, 0);
  const pcs = farms.reduce(function(n, f){ return n + (f.pcs || []).length; }, 0);
  const machines = farms.reduce(function(n, f){ return n + (f.machines || 0); }, 0);
  const online = farms.reduce(function(n, f){ return n + (f.networks || []).reduce(function(m, x){ return m + x.online; }, 0); }, 0);
  el.innerHTML = '<span class="pill"><b>' + farms.length + '</b> farms</span>'
    + '<span class="pill"><span class="sdot ' + (pcsOn === pcs && pcs ? 'on' : 'off') + '"></span><b>' + pcsOn + '/' + pcs + '</b> agents online</span>'
    + '<span class="pill"><b>' + online + '/' + machines + '</b> machines online</span>'
    + (farmsState.pending.length ? '<span class="pill" style="border-color:rgba(251,191,36,.45);color:#fcd34d"><b style="color:#fcd34d">' + farmsState.pending.length + '</b> waiting for a farm</span>' : '')
    + pollPill();
}

// Remote Access › Add a farm PC › Download agent: the current agent folder
// as one .zip, built by the server from where the agents update themselves.
function downloadAgent() {
  const btn = document.getElementById('agentDlBtn');
  const token = localStorage.getItem('ekl_token') || '';
  if (btn) btn.disabled = true;
  toast('Preparing the agent download…', 'var(--cyan)');
  fetch(API_BASE + '/api/agents/download', { headers: { 'Authorization': 'Bearer ' + token } })
    .then(function(r){
      if (!r.ok) return r.json().catch(function(){ return {}; }).then(function(d){ throw new Error(d.error || ('HTTP ' + r.status)); });
      const cd = r.headers.get('Content-Disposition') || '', ver = r.headers.get('X-Agent-Version') || '';
      const m = cd.match(/filename="?([^";]+)"?/);
      const name = (m && m[1]) || ('ekalavya-agent' + (ver ? '-v' + ver : '') + '.zip');
      return r.blob().then(function(b){ return { blob: b, name: name }; });
    })
    .then(function(f){
      const a = document.createElement('a');
      a.href = URL.createObjectURL(f.blob); a.download = f.name;
      document.body.appendChild(a); a.click();
      setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      toast('✓ ' + f.name + ' downloaded — unzip it on the farm PC and run SETUP-WINDOWS.bat', 'var(--green)');
    })
    .catch(function(e){ toast('✗ Could not download the agent: ' + e.message, 'var(--red)'); })
    .then(function(){ if (btn) btn.disabled = false; });
}

// How often the agents poll the machines — one setting for all farms.
const POLL_CHOICES = [[30, '30 s'], [60, '1 min'], [120, '2 min'], [180, '3 min'], [300, '5 min'], [600, '10 min']];
function pollPill() {
  const cur = farmsState.poll_sec || 30;
  const dd = document.getElementById('pollSel');
  if (dd && document.activeElement === dd) return dd.closest('.pill').outerHTML;     // don't rebuild it under the user's finger
  const opts = POLL_CHOICES.slice();
  if (!opts.some(function(o){ return o[0] === cur; })) opts.push([cur, cur >= 60 ? (cur / 60) + ' min' : cur + ' s']);
  opts.sort(function(a, b){ return a[0] - b[0]; });
  return '<label class="pill" title="Gap between two polls of the machines, for every farm. A longer gap means less traffic to the miners; the dashboard, alarms and auto-restart then see a change up to that much later.">Poll every '
    + '<select id="pollSel" class="poll-sel" onchange="savePollGap(this.value)">'
    + opts.map(function(o){ return '<option value="' + o[0] + '"' + (o[0] === cur ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('')
    + '</select></label>';
}
function savePollGap(v) {
  const sec = parseInt(v, 10);
  const token = localStorage.getItem('ekl_token') || '';
  fetch(API_BASE + '/api/farms/poll', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({ poll_sec: sec }) })
    .then(function(r){ return r.json().catch(function(){ return { ok: false, error: 'HTTP ' + r.status }; }).then(function(d){ if (r.status === 403) d = { ok: false, error: 'Only an admin or manager can change this' }; return d; }); })
    .then(function(d){
      const dd = document.getElementById('pollSel'); if (dd) dd.blur();
      if (!d || !d.ok) { toast('✗ ' + ((d && d.error) || 'Could not save'), 'var(--red)'); renderRaSummary(); return; }
      farmsState = { farms: d.farms || farmsState.farms, pending: d.pending || [], poll_sec: d.poll_sec };
      renderFarmsPanel();
      toast('✓ Agents now poll every ' + (sec >= 60 ? (sec / 60) + ' min' : sec + ' s'), 'var(--green)');
    })
    .catch(function(e){ toast('✗ ' + e.message, 'var(--red)'); });
}

function renderFarmsPanel() {
  const el = document.getElementById('farmsList'); if (!el) return;
  const b = document.getElementById('farmsBadge'); if (b) b.textContent = farmsState.farms.length;
  renderRaSummary();
  if (!farmsState.farms.length) { el.innerHTML = '<div style="color:var(--mute);font-size:12.5px;padding:6px 2px">No farms yet &mdash; they appear when an agent PC is given one.</div>'; return; }
  const nameCount = {}; farmsState.farms.forEach(function(f){ nameCount[f.name] = (nameCount[f.name] || 0) + 1; });
  el.innerHTML = farmsState.farms.map(function(f){ return farmCard(f, nameCount[f.name] > 1); }).join('');
}

function farmCard(f, dup) {
  const nets = f.networks || [];
  const inService = nets.reduce(function(n, x){ return n + x.total; }, 0);
  const online = nets.reduce(function(n, x){ return n + x.online; }, 0);
  const repair = Math.max(0, (f.machines || 0) - inService);
  const pc = (f.pcs || [])[0];
  const ag = (agents || []).find(function(a){ return a.id === f.farm_id; });
  const p = f.polling;
  const set = (f.subnets || []).length;
  // alerts, short — the detail is in each chip's tip
  const alerts = [];
  const dark = nets.filter(function(n){ return n.total >= 3 && n.online === 0; });
  if (f.online && dark.length) alerts.push('<span class="chip warn">&#9888; ' + dark.length + ' network' + (dark.length > 1 ? 's' : '') + ' dark<span class="tip" tabindex="0" data-tip="No machine online on ' + escAttr(dark.map(function(n){ return n.net + '.x'; }).join(', ')) + '. If those machines are running, the network isn&rsquo;t being polled &mdash; add it in IP ranges.">i</span></span>');
  const foreign = [];
  if (set) farmsState.farms.forEach(function(g){
    if (g.farm_id === f.farm_id) return;
    (g.known_subnets || []).forEach(function(n){ if (rangeCovers(f.subnets, n.split('.').slice(0, 3).join('.') + '.1')) foreign.push(g.name + ' ' + n); });
  });
  if (foreign.length) alerts.push('<span class="chip bad">&#9888; ranges overlap ' + escHtml(foreign[0].split(' ')[0]) + '<span class="tip" tabindex="0" data-tip="These IP ranges cover another farm&rsquo;s machines (' + escAttr(foreign.join(', ')) + '). Unless both sites use the same network numbers, open IP ranges and choose Use automatic.">i</span></span>');
  if (p && f.known_subnets) {
    const missing = f.known_subnets.filter(function(n){ return !rangeCovers(p.subnets || [], n.split('.').slice(0, 3).join('.') + '.1'); });
    if (missing.length) alerts.push('<span class="chip warn">&#9888; ' + missing.length + ' not polled<span class="tip" tabindex="0" data-tip="Machines are on ' + escAttr(missing.join(', ')) + ', which this agent doesn&rsquo;t poll, so they show offline. Add it in IP ranges.">i</span></span>');
  }
  if (dup) alerts.push('<span class="chip warn">duplicate name<span class="tip" tabindex="0" data-tip="Another farm has the same name. If it&rsquo;s the same site, use &#8943; &rarr; Merge into&hellip; on the one to remove.">i</span></span>');
  if (ag && ag.crash_count_5m > 0) alerts.push('<span class="chip bad">&#9888; ' + ag.crash_count_5m + ' agent restarts (5 min)</span>');

  const netChips = nets.map(function(n){
    const cls = n.online === n.total ? 'ok' : (n.total >= 3 && n.online === 0 ? 'warn' : '');
    return '<span class="chip ' + cls + '">' + escHtml(n.net) + '.x <b style="color:inherit">' + n.online + '/' + n.total + '</b></span>';
  }).join('');

  const pcLine = pc
    ? '<div class="fc-line"><svg class="ic sm"><use href="#i-monitor"/></svg><span class="sdot ' + (pc.online ? 'on' : 'off') + '"></span><span class="t"><b>' + escHtml(pc.hostname || 'PC') + '</b> &middot; ' + escHtml((pc.ips || [])[0] || '—')
      + ((ag && ag.agent_version) || pc.version ? ' &middot; v' + escHtml((ag && ag.agent_version) || pc.version) : '') + (pc.older_agent ? ' &middot; update pending' : '') + '</span></div>'
    : '<div class="fc-line"><svg class="ic sm"><use href="#i-monitor"/></svg><span class="t">No agent PC</span></div>';
  const pollTxt = p
    ? (p.subnets || []).length + ' range' + ((p.subnets || []).length === 1 ? '' : 's') + ' &middot; ' + p.addresses + ' addresses &middot; ' + Math.round((p.cycle_ms || 0) / 1000) + ' s cycle' + (p.poll_sec ? ' &middot; every ' + (p.poll_sec >= 60 ? (p.poll_sec / 60) + ' min' : p.poll_sec + ' s') : '')
    : (set ? 'Custom ranges' : 'Automatic ranges');
  const pollTip = p ? (p.subnets || []).join(', ') + ' (' + (p.from || '') + ') · ' + p.found + ' found last cycle'
    : (set ? f.subnets.join(', ') : 'LOCAL_SUBNET + the networks this farm’s machines are on') + (f.online ? ' · agents from v1.1.43 report exactly what they poll' : '');
  const pollLine = '<div class="fc-line"><svg class="ic sm"><use href="#i-globe"/></svg><span class="t">' + pollTxt + '</span><span class="tip" tabindex="0" data-tip="' + escAttr(pollTip) + '">i</span></div>';

  return '<div class="fcard' + (f.online ? '' : ' off') + '">'
    + '<div class="fc-h"><span class="sdot ' + (f.online ? 'on' : 'off') + '"></span><b title="' + escAttr(f.name) + '">' + escHtml(f.name) + '</b>'
    + (dup || f.name !== f.farm_id ? '<span class="fc-id">' + escHtml(f.farm_id) + '</span>' : '')
    + '<button class="fc-more" type="button" title="More" onclick="farmMenu(event,\'' + escAttr(f.farm_id) + '\')">&#8943;</button></div>'
    + '<div class="fc-k"><div class="g"><b>' + online + '</b><span>Online</span></div><div class="' + (inService - online ? 'r' : '') + '"><b>' + (inService - online) + '</b><span>Offline</span></div>'
    + '<div><b>' + (f.machines || 0) + '</b><span>' + (repair ? repair + ' in repair' : 'Machines') + '</span></div></div>'
    + (netChips ? '<div class="chips">' + netChips + '</div>' : '')
    + pcLine + pollLine
    + (alerts.length ? '<div class="chips">' + alerts.join('') + '</div>' : '')
    + '<div class="fc-a">'
    + (f.online ? '<button class="abtn" type="button" onclick="triggerScan(\'' + escAttr(f.farm_id) + '\')"><svg class="ic sm"><use href="#i-search"/></svg>Scan</button>' : '')
    + '<button class="abtn" type="button" onclick="openRanges(\'' + escAttr(f.farm_id) + '\')"><svg class="ic sm"><use href="#i-globe"/></svg>IP ranges</button></div>'
    + '</div>';
}

// ⋯ menu on a farm card
function farmMenu(ev, fid) {
  ev.stopPropagation();
  closeMenus();
  const f = farmById(fid); if (!f) return;
  const pc = (f.pcs || [])[0];
  const ag = (agents || []).find(function(a){ return a.id === fid; });
  const items = [
    ['&#x270E; Rename farm', 'renameFarmUi', fid],
    pc && pc.pc_id ? ['&#8644; Move PC to another farm', 'changePcFarm', pc.pc_id] : null,
    farmsState.farms.length > 1 ? ['&#10549; Merge into another farm', 'mergeFarmUi', fid] : null,
    'hr',
    pc && pc.pc_id && !pc.online ? ['Forget this PC', 'forgetPc', pc.pc_id, 'danger'] : null,
    ag && !ag.online ? ['Remove offline agent', 'removeAgent', fid, 'danger'] : null,
    !f.machines && !(f.pcs || []).length && !f.online ? ['Delete empty farm', 'deleteFarmUi', fid, 'danger'] : null,
  ].filter(Boolean);
  while (items.length && items[items.length - 1] === 'hr') items.pop();
  const m = document.createElement('div');
  m.className = 'menu-pop';
  m.innerHTML = items.map(function(it){
    if (it === 'hr') return '<hr>';
    return '<button type="button" class="' + (it[3] || '') + '" data-fn="' + it[1] + '" data-arg="' + escAttr(it[2]) + '">' + it[0] + '</button>';
  }).join('');
  document.body.appendChild(m);
  const r = ev.currentTarget.getBoundingClientRect();
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)) + 'px';
  m.style.top = (r.bottom + 6 + h > window.innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6) + 'px';
  m.addEventListener('click', function(e){
    const bt = e.target.closest('button'); if (!bt) return;
    closeMenus();
    const fn = window[bt.getAttribute('data-fn')]; if (typeof fn === 'function') fn(bt.getAttribute('data-arg'));
  });
}
function closeMenus() { document.querySelectorAll('.menu-pop').forEach(function(m){ m.remove(); }); }
document.addEventListener('click', function(e){ if (!e.target.closest('.menu-pop')) closeMenus(); });
document.addEventListener('keydown', function(e){ if (e.key === 'Escape') { closeMenus(); hideTip(); } });
window.addEventListener('scroll', closeMenus, true);

// ⓘ tips: one floating box, kept inside the screen (works with tap on phones)
let tipEl = null;
function showTip(t) {
  const txt = t.getAttribute('data-tip'); if (!txt) return;
  if (!tipEl) { tipEl = document.createElement('div'); tipEl.id = 'tipPop'; document.body.appendChild(tipEl); }
  tipEl.innerHTML = txt; tipEl.style.display = 'block';
  const r = t.getBoundingClientRect(), w = tipEl.offsetWidth, h = tipEl.offsetHeight;
  tipEl.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + 'px';
  tipEl.style.top = (r.bottom + 8 + h > window.innerHeight ? Math.max(8, r.top - h - 8) : r.bottom + 8) + 'px';
}
function hideTip() { if (tipEl) tipEl.style.display = 'none'; }
document.addEventListener('mouseover', function(e){ const t = e.target.closest && e.target.closest('.tip'); if (t) showTip(t); });
document.addEventListener('mouseout', function(e){ const t = e.target.closest && e.target.closest('.tip'); if (t && !t.contains(e.relatedTarget)) { if (document.activeElement !== t) hideTip(); } });
document.addEventListener('focusin', function(e){ const t = e.target.closest && e.target.closest('.tip'); if (t) showTip(t); else hideTip(); });
document.addEventListener('focusout', function(e){ if (e.target.closest && e.target.closest('.tip')) hideTip(); });
window.addEventListener('scroll', hideTip, true);

// keep the farm cards fresh while Remote Access is open
setInterval(function(){ const pg = document.getElementById('page-agents'); if (pg && pg.classList.contains('active')) loadFarms(); }, 30000);

// Same range formats as the agent (agent.js subnetToIPs), for the count
// shown while typing and for the "not polled" warning.
function rangeToBounds(r) {
  r = String(r || '').trim().replace(/\s+/g, '');
  const ip = function(x){ const p = x.split('.'); if (p.length !== 4) return null; const n = p.map(Number); if (n.some(function(v){ return !/^\d{1,3}$/.test(String(v)) || v > 255; })) return null; return ((n[0] << 24) >>> 0) + (n[1] << 16) + (n[2] << 8) + n[3]; };
  let m;
  if ((m = r.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/))) { const b = ip(m[1]), bits = +m[2]; if (b === null || bits < 8 || bits > 32) return null; const size = Math.pow(2, 32 - bits); const net = b - (b % size); return bits >= 31 ? [net, net + size - 1, size] : [net + 1, net + size - 2, size - 2]; }
  if ((m = r.match(/^(\d+\.\d+\.\d+\.\d+)-(\d+\.\d+\.\d+\.\d+)$/))) { const a = ip(m[1]), b = ip(m[2]); return a === null || b === null || b < a ? null : [a, b, b - a + 1]; }
  if ((m = r.match(/^(\d+\.\d+\.\d+)\.(\d+)-(\d+)$/))) { const a = ip(m[1] + '.' + m[2]), b = ip(m[1] + '.' + m[3]); return a === null || b === null || b < a ? null : [a, b, b - a + 1]; }
  if ((m = r.match(/^(\d+\.\d+)\.(\d+)-(\d+)(?:\.\*)?$/))) { const a = ip(m[1] + '.' + m[2] + '.1'), b = ip(m[1] + '.' + m[3] + '.254'); return a === null || b === null || b < a ? null : [a, b, (+m[3] - +m[2] + 1) * 254]; }
  if ((m = r.match(/^(\d+\.\d+\.\d+)(?:\.\*)?$/))) { const a = ip(m[1] + '.1'); return a === null ? null : [a, a + 253, 254]; }
  const one = ip(r); return one === null ? null : [one, one, 1];
}
function rangeCovers(list, addr) {
  const p = addr.split('.').map(Number); const n = ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
  return (list || []).some(function(r){ const b = rangeToBounds(r); return b && n >= b[0] && n <= b[1]; });
}
let rangesFarm = null;
function openRanges(fid) {
  const f = farmById(fid); if (!f) return;
  rangesFarm = fid;
  const t = document.getElementById('rangesTitle'); if (t) t.textContent = 'IP ranges — ' + f.name;
  const ta = document.getElementById('rangesText'); if (ta) ta.value = (f.subnets || []).join('\n');
  rangesPreview();
  openSheet('rangesSheet');
}
function rangesPreview() {
  const f = farmById(rangesFarm); const el = document.getElementById('rangesInfo'); if (!el || !f) return;
  const lines = (document.getElementById('rangesText').value || '').split(/[\n,]+/).map(function(x){ return x.trim(); }).filter(Boolean);
  const bad = [], big = []; let total = 0;
  lines.forEach(function(l){ const b = rangeToBounds(l); if (!b) bad.push(l); else { total += Math.min(b[2], 4096); if (b[2] > 4096) big.push(l); } });
  let html = '';
  if (!lines.length) {
    html = '<b>Automatic:</b> LOCAL_SUBNET from the PC’s .env, plus every network this farm’s machines are on'
      + ((f.known_subnets || []).length ? ' (' + escHtml(f.known_subnets.join(', ')) + ')' : '') + '. With neither, the PC’s own networks.';
  } else {
    html = lines.length + ' range' + (lines.length === 1 ? '' : 's') + ', ' + total.toLocaleString() + ' addresses polled every cycle.';
    const missing = (f.known_subnets || []).filter(function(n){ return !rangeCovers(lines, n.split('.').slice(0, 3).join('.') + '.1'); });
    if (missing.length) html += '<br><span style="color:var(--warn)">&#9888; This farm has machines on ' + escHtml(missing.join(', ')) + ' — not in these ranges, so they would show offline.</span>';
    const foreign = [];
    farmsState.farms.forEach(function(g){ if (g.farm_id !== f.farm_id) (g.known_subnets || []).forEach(function(n){ if (rangeCovers(lines, n.split('.').slice(0, 3).join('.') + '.1')) foreign.push(g.name + ' (' + n + ')'); }); });
    if (foreign.length) html += '<br><span style="color:var(--red)">&#9888; These ranges include another farm’s machines: ' + escHtml(foreign.join(', ')) + '. Unless both sites really use the same network numbers, leave them to the PC at that farm.</span>';
  }
  if (big.length) html += '<br><span style="color:var(--warn)">&#9888; Over 4,096 addresses, only the first 4,096 are polled: ' + escHtml(big.join(', ')) + '</span>';
  if (bad.length) html += '<br><span style="color:var(--red)">&#10007; Not an IP range: ' + escHtml(bad.join(', ')) + '</span>';
  el.innerHTML = html;
  const sv = document.getElementById('rangesSave'); if (sv) sv.disabled = !!bad.length;
}
function saveRanges(auto) {
  const f = farmById(rangesFarm); if (!f) return;
  const lines = auto ? [] : (document.getElementById('rangesText').value || '').split(/[\n,]+/).map(function(x){ return x.trim(); }).filter(Boolean);
  if (!auto && !lines.length) { if (!confirm('No ranges typed — use automatic ranges?')) return; }
  const token = localStorage.getItem('ekl_token') || '';
  fetch(API_BASE + '/api/fleet/agent-config', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ farm_id: f.farm_id, subnets: lines, name: f.name })
  })
  .then(function(r){ return r.json().catch(function(){ return { ok: false, error: 'HTTP ' + r.status }; }); })
  .then(function(d){
    if (!d || !d.ok) { toast('✗ ' + ((d && d.error) || 'Could not save'), 'var(--red)'); return; }
    closeSheet('rangesSheet');
    try { localStorage.setItem('agent_subnets_' + f.farm_id, JSON.stringify(lines)); } catch (e) {}
    toast('✓ ' + f.name + ': ' + (lines.length ? lines.length + ' range(s) saved' : 'automatic ranges') + (d.sent_to_agent ? ' — agent updated' : ' — sent when its agent connects'), 'var(--green)');
    setTimeout(loadFarms, 400);
  })
  .catch(function(e){ toast('✗ ' + e.message, 'var(--red)'); });
}

function openFarmPicker(opts) {
  farmPick = opts;
  const t = document.getElementById('farmPickTitle'); if (t) t.textContent = opts.title;
  const n = document.getElementById('farmPickNote'); if (n) n.textContent = opts.note || '';
  const ok = document.getElementById('farmPickOk'); if (ok) ok.textContent = opts.okLabel || 'Assign';
  const sel = document.getElementById('farmPickSel');
  if (sel) {
    sel.innerHTML = (opts.allowNew ? '<option value="__new">&#x2795; New farm&hellip;</option>' : '<option value="">Choose&hellip;</option>')
      + farmsState.farms.filter(function(f){ return f.farm_id !== opts.exclude; }).map(function(f){
          return '<option value="' + escAttr(f.farm_id) + '">' + escHtml(f.name) + ' (' + f.machines + ' machine' + (f.machines === 1 ? '' : 's') + (f.online ? ', online' : '') + ')</option>';
        }).join('');
    sel.value = opts.preselect && farmById(opts.preselect) ? opts.preselect : (opts.allowNew ? '__new' : '');
  }
  const nm = document.getElementById('farmPickName'); if (nm) nm.value = '';
  farmPickChanged();
  openSheet('farmPickSheet');
}
function farmPickChanged() {
  const sel = document.getElementById('farmPickSel'), row = document.getElementById('farmPickNewRow');
  if (row) row.style.display = sel && sel.value === '__new' ? '' : 'none';
}
function farmPickConfirm() {
  if (!farmPick) return;
  const sel = document.getElementById('farmPickSel'), nm = document.getElementById('farmPickName');
  const v = sel ? sel.value : '';
  let choice;
  if (v === '__new') {
    const name = (nm && nm.value || '').trim();
    if (!name) { toast('Type the new farm name', 'var(--warn)'); if (nm) nm.focus(); return; }
    choice = { new_farm_name: name };
  } else if (v) choice = { farm_id: v };
  else { toast('Choose a farm', 'var(--warn)'); return; }
  const cb = farmPick.onOk;
  closeSheet('farmPickSheet'); farmPick = null;
  cb(choice);
}

function farmApi(method, path, body) {
  const token = localStorage.getItem('ekl_token') || '';
  return fetch(API_BASE + '/api/farms' + path, {
    method: method, headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: body ? JSON.stringify(body) : undefined
  })
  .then(function(r){ return r.json().catch(function(){ return { ok: false, error: 'HTTP ' + r.status }; })
    .then(function(d){ if (r.status === 403) d = { ok: false, error: 'Only an admin or manager can change farms' }; return d; }); })
  .then(function(d){
    if (!d || !d.ok) { toast('✗ ' + ((d && d.error) || 'Could not save'), 'var(--red)'); return null; }
    if (d.farms) { farmsState = { farms: d.farms, pending: d.pending || [], poll_sec: d.poll_sec || farmsState.poll_sec }; renderFarmsPanel(); renderPendingAgents(); }
    // names / farms of machines changed on the server — bring them in
    try { fetchAgents(); } catch (e) {}
    try { loadFleetFromBackend(function(){ try { _fleetHash = ''; renderWorkers(); renderDash(); } catch (e) {} }); } catch (e) {}
    return d;
  })
  .catch(function(e){ toast('✗ ' + e.message, 'var(--red)'); return null; });
}

function assignPendingPc(pcId) {
  const p = farmsState.pending.find(function(x){ return x.pc_id === pcId; }); if (!p) return;
  openFarmPicker({
    title: 'Farm for ' + (p.hostname || 'this PC'),
    note: 'This PC will poll that farm’s machines. Choose the farm it sits in, or make a new one.',
    allowNew: true, preselect: p.suggested_farm_id, okLabel: 'Assign',
    onOk: function(c){
      farmApi('POST', '/assign', Object.assign({ pc_id: pcId }, c)).then(function(d){ if (d) toast('✓ ' + (p.hostname || 'PC') + ' → ' + d.farm_name, 'var(--green)'); });
    }
  });
}
function changePcFarm(pcId) {
  let pc = null, cur = null;
  farmsState.farms.forEach(function(f){ (f.pcs || []).forEach(function(x){ if (x.pc_id === pcId) { pc = x; cur = f; } }); });
  if (!pc) return;
  openFarmPicker({
    title: 'Move ' + (pc.hostname || 'PC') + ' to another farm',
    note: 'Its agent reconnects at once and polls the chosen farm. Machines already recorded stay where they are — use “Merge into” to move a farm’s machines.',
    allowNew: true, exclude: cur && cur.farm_id, okLabel: 'Move',
    onOk: function(c){
      farmApi('POST', '/assign', Object.assign({ pc_id: pcId }, c)).then(function(d){ if (d) toast('✓ ' + (pc.hostname || 'PC') + ' → ' + d.farm_name, 'var(--green)'); });
    }
  });
}
function renameFarmUi(fid) {
  const f = farmById(fid); if (!f) return;
  const name = prompt('New name for "' + f.name + '":', f.name);
  if (name === null) return;
  if (!name.trim() || name.trim() === f.name) return;
  farmApi('POST', '/' + encodeURIComponent(fid) + '/rename', { name: name.trim() }).then(function(d){ if (d) toast('✓ Renamed to ' + name.trim(), 'var(--green)'); });
}
function mergeFarmUi(fid) {
  const f = farmById(fid); if (!f) return;
  openFarmPicker({
    title: 'Merge “' + f.name + '” into…',
    note: 'All ' + f.machines + ' machine record(s) and any PC of “' + f.name + '” move to the farm you choose, and “' + f.name + '” is removed. Use this for a duplicate farm.',
    allowNew: false, exclude: fid, okLabel: 'Merge',
    onOk: function(c){
      const into = farmById(c.farm_id);
      if (!confirm('Move ' + f.machines + ' machine(s) from "' + f.name + '" into "' + (into ? into.name : c.farm_id) + '" and remove "' + f.name + '"?')) return;
      farmApi('POST', '/' + encodeURIComponent(fid) + '/merge', { into: c.farm_id }).then(function(d){ if (d) toast('✓ Merged — ' + d.moved + ' machine record(s) moved', 'var(--green)'); });
    }
  });
}
function deleteFarmUi(fid) {
  const f = farmById(fid); if (!f) return;
  if (!confirm('Delete the empty farm "' + f.name + '"?')) return;
  farmApi('DELETE', '/' + encodeURIComponent(fid)).then(function(d){ if (d) toast('✓ Farm deleted', 'var(--green)'); });
}
function forgetPc(pcId) {
  if (!confirm('Forget this PC? If its agent ever runs again it will wait under New agents.')) return;
  farmApi('DELETE', '/pc/' + encodeURIComponent(pcId)).then(function(d){ if (d) toast('✓ PC forgotten', 'var(--green)'); });
}

function authFetch(path) {
  const base = (typeof API_BASE !== 'undefined') ? API_BASE : '';
  if (!base || base.includes('localhost')) return Promise.resolve(null);
  const token = localStorage.getItem('ekl_token') || '';
  return fetch(base + path, { headers: { 'Authorization': 'Bearer ' + token } })
    .then(function(r){ return r.ok ? r.json() : null; })
    .catch(function(){ return null; });
}

// Hashrate is stored normalised to TH/s so one column fits every
// machine. Scrypt miners are quoted in GH/s, so showing "0.021 TH/s"
// for an L11 would be technically right and completely unreadable.
function fmtHashrate(th, unitHint) {
  if (th === null || th === undefined || !isFinite(th)) return '—';
  const u = (unitHint || '').toUpperCase();
  if (u.indexOf('GH') === 0) return (th * 1000).toFixed(2) + ' GH/s';
  if (u.indexOf('MH') === 0) return (th * 1e6).toFixed(0) + ' MH/s';
  if (u.indexOf('PH') === 0) return (th / 1000).toFixed(3) + ' PH/s';
  return th.toFixed(1) + ' TH/s';
}

function loadMinerHistory(wid, hours) {
  histState.wid = wid;
  histState.hours = hours || histState.hours || 168;
  histState.hoverX = null;
  document.querySelectorAll('.hist-range-btn').forEach(function(b){
    b.classList.toggle('active', Number(b.dataset.hours) === histState.hours);
  });
  authFetch('/api/insights/history/' + encodeURIComponent(wid) + '?hours=' + histState.hours)
    .then(function(d){
      if (histState.wid !== wid) return; // panel moved on to another machine mid-fetch
      histState.points = (d && d.ok) ? d.history : [];
      drawHistChart();
    });
}

function onHistRangeClick(hours) {
  if (!activeWid) return;
  loadMinerHistory(activeWid, hours);
}

// Vanilla canvas line chart — no library needed for one line + a
// hover readout. Redraws from scratch each time; the dataset here
// (at most ~4300 points for 30 days at 10-min slots) is tiny for that.
function drawHistChart() {
  const canvas = document.getElementById('histCanvas');
  const empty  = document.getElementById('histEmpty');
  const tip    = document.getElementById('histTooltip');
  const sum    = document.getElementById('histSummary');
  if (!canvas) return;

  const pts = (histState.points || []).filter(function(p){ return p.hashrate_th !== null && p.hashrate_th !== undefined; });

  if (!pts.length) {
    canvas.style.display = 'none';
    if (empty) empty.style.display = 'block';
    if (tip) tip.style.display = 'none';
    if (sum) sum.textContent = '';
    return;
  }
  canvas.style.display = 'block';
  if (empty) empty.style.display = 'none';

  // Uptime + avg over the loaded window, computed here so it always
  // matches exactly what the chart is showing (same range, same fetch).
  const all = histState.points || [];
  const onlineCount = all.filter(function(p){ return p.status === 'online'; }).length;
  const uptimePct = all.length ? (100 * onlineCount / all.length) : null;
  const avgTh = pts.reduce(function(s,p){ return s + Number(p.hashrate_th); }, 0) / pts.length;
  const peakTh = pts.reduce(function(m,p){ return Math.max(m, Number(p.hashrate_th)); }, 0);
  if (sum) {
    sum.textContent = (uptimePct !== null ? uptimePct.toFixed(1) + '% uptime' : '—')
      + '  ·  avg ' + fmtHashrate(avgTh)
      + '  ·  peak ' + fmtHashrate(peakTh);
  }

  // Backing-store scaled for device pixel ratio so the line stays sharp.
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(rect.width, 200), h = 180;
  canvas.width = w * dpr; canvas.height = h * dpr;
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const padL = 4, padR = 4, padT = 10, padB = 18;
  const plotW = w - padL - padR, plotH = h - padT - padB;

  const times = pts.map(function(p){ return new Date(p.slot).getTime(); });
  const vals  = pts.map(function(p){ return Number(p.hashrate_th); });
  const tMin = times[0], tMax = times[times.length - 1] || tMin + 1;
  const vMax = Math.max.apply(null, vals) * 1.1 || 1;
  const vMin = 0; // hashrate chart reads better anchored at zero — a dip to 0 (offline) is the whole point

  function xAt(t){ return padL + (tMax > tMin ? (t - tMin) / (tMax - tMin) : 0) * plotW; }
  function yAt(v){ return padT + plotH - ((v - vMin) / (vMax - vMin)) * plotH; }

  // Gridlines
  ctx.strokeStyle = 'rgba(148,163,184,.12)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const gy = padT + (plotH / 3) * i;
    ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(w - padR, gy); ctx.stroke();
  }

  // Filled area under the line
  const cs = getComputedStyle(document.documentElement);
  const cyan = (cs.getPropertyValue('--cyan') || '#00e5ff').trim();
  ctx.beginPath();
  ctx.moveTo(xAt(times[0]), yAt(0));
  pts.forEach(function(p, i){ ctx.lineTo(xAt(times[i]), yAt(vals[i])); });
  ctx.lineTo(xAt(times[times.length - 1]), yAt(0));
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
  grad.addColorStop(0, cyan + '33'); grad.addColorStop(1, cyan + '02');
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  pts.forEach(function(p, i){
    const x = xAt(times[i]), y = yAt(vals[i]);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = cyan;
  ctx.lineWidth = 1.6;
  ctx.stroke();

  // X-axis date labels (start / mid / end)
  ctx.fillStyle = 'rgba(148,163,184,.7)';
  ctx.font = '9px "Share Tech Mono", monospace';
  function fmtAxisDate(ts){
    const d = new Date(ts);
    return histState.hours <= 48
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  ctx.textAlign = 'left';  ctx.fillText(fmtAxisDate(tMin), padL, h - 4);
  ctx.textAlign = 'right'; ctx.fillText(fmtAxisDate(tMax), w - padR, h - 4);

  // Hover crosshair + tooltip
  if (histState.hoverX !== null) {
    const targetT = tMin + (Math.min(Math.max(histState.hoverX - padL, 0), plotW) / plotW) * (tMax - tMin);
    let nearest = 0, best = Infinity;
    times.forEach(function(t, i){ const d = Math.abs(t - targetT); if (d < best) { best = d; nearest = i; } });
    const hx = xAt(times[nearest]), hy = yAt(vals[nearest]);

    ctx.strokeStyle = 'rgba(148,163,184,.35)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(hx, padT); ctx.lineTo(hx, padT + plotH); ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath(); ctx.arc(hx, hy, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = cyan; ctx.fill();

    if (tip) {
      const d = new Date(times[nearest]);
      const statusRow = pts[nearest] && pts[nearest].status ? pts[nearest].status : '';
      tip.innerHTML = '<div style="color:var(--cyan);font-weight:700">' + fmtHashrate(vals[nearest]) + '</div>'
        + '<div style="color:var(--mute);font-size:10px">' + d.toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) + '</div>'
        + (statusRow ? '<div style="color:var(--mute);font-size:9px;text-transform:uppercase">' + statusRow + '</div>' : '');
      tip.style.display = 'block';
      let left = hx + 10;
      if (left + 120 > w) left = hx - 120;
      tip.style.left = left + 'px';
      tip.style.top  = Math.max(hy - 40, 0) + 'px';
    }
  } else if (tip) {
    tip.style.display = 'none';
  }
}

(function wireHistChart(){
  document.addEventListener('click', function(e){
    const btn = e.target.closest && e.target.closest('.hist-range-btn');
    if (btn) onHistRangeClick(Number(btn.dataset.hours));
  });
  document.addEventListener('mousemove', function(e){
    const canvas = document.getElementById('histCanvas');
    if (!canvas || canvas.style.display === 'none') return;
    const rect = canvas.getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
      if (histState.hoverX !== null) { histState.hoverX = null; drawHistChart(); }
      return;
    }
    histState.hoverX = e.clientX - rect.left;
    drawHistChart();
  });
  document.addEventListener('mouseleave', function(e){
    if (e.target && e.target.id === 'histCanvas' && histState.hoverX !== null) {
      histState.hoverX = null; drawHistChart();
    }
  }, true);
  window.addEventListener('resize', function(){ if (histState.wid) drawHistChart(); });
})();

function clearWorkerFilters(){
  workerFilter = 'all';
  workerAgentFilter = 'all';
  const sel = document.getElementById('wAgentFilter'); if (sel) sel.value = 'all';
  const box = document.getElementById('wSearch');      if (box) box.value = '';
  // Put the highlight back on the "All" status button. Scoped to the
  // workers page — other pages have their own .fbtn toolbars.
  document.querySelectorAll('#page-workers .toolbar .fbtn').forEach(function(b, i){
    b.classList.toggle('active', i === 0);
  });
  _workersHash = '';
  renderWorkers();
}

function onWorkerAgentFilterChange(){
  const sel = document.getElementById('wAgentFilter');
  workerAgentFilter = sel ? sel.value : 'all';
  _workersHash = '';
  renderWorkers();
}

// Rebuilt whenever the fleet or agent list changes. Options come from
// the farm ids actually present on workers UNIONed with the connected
// agents — a site whose agent is currently offline still has machines
// worth filtering to, and a freshly-connected agent with no machines
// yet should still be selectable.
function refreshAgentFilterOptions(){
  const sel = document.getElementById('wAgentFilter');
  if (!sel) return;

  const ids = {};
  workers.forEach(function(w){
    if (w.farm_id) ids[w.farm_id] = w.farm || null;
  });
  agents.forEach(function(a){
    if (a && a.id && !(a.id in ids)) ids[a.id] = a.name || null;
  });

  const list = Object.keys(ids).map(function(id){
    const ag = agents.find(function(a){ return a.id === id; });
    return { id: id, name: (ag && ag.name) || ids[id] || id };
  }).sort(function(a, b){ return a.name.localeCompare(b.name); });

  // Don't rebuild if nothing changed — doing so would reset the user's
  // current selection on every 30-second refresh.
  const sig = list.map(function(x){ return x.id + '|' + x.name; }).join(',');
  if (sel.dataset.sig === sig) return;
  sel.dataset.sig = sig;

  const prev = workerAgentFilter;
  sel.innerHTML = '<option value="all">All sites</option>'
    + list.map(function(x){
        const count = workers.filter(function(w){ return w.farm_id === x.id; }).length;
        return '<option value="' + escAttr(x.id) + '">' + escHtml(x.name) + ' (' + count + ')</option>';
      }).join('');

  // Keep the selection if that site still exists; otherwise fall back
  // to All rather than silently showing a different site's machines.
  if (prev !== 'all' && list.some(function(x){ return x.id === prev; })) sel.value = prev;
  else { sel.value = 'all'; workerAgentFilter = 'all'; }
}

function escHtml(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}
function escAttr(s){ return escHtml(s); }
function bulkReboot(){
  const checked = Array.from(document.querySelectorAll('.worker-check:checked')).map(function(c){ return c.dataset.wid; });
  if(checked.length === 0){ alert('Select miners first'); return; }
  if(!confirm('Reboot ' + checked.length + ' miners?')) return;
  toast('Reboot command sent to ' + checked.length + ' miners', 'var(--cyan)');
}
function openMinerWebUI(wid){
  const w = workers.find(function(x){ return x.id === (wid || activeWid); });
  if(!w){ toast('No miner selected', 'var(--warn)'); return; }
  if(!w.ip){ toast('No IP address for this miner', 'var(--red)'); return; }

  const useTailscale = localStorage.getItem('use_tailscale_webui') === 'true';
  var url;

  if (useTailscale) {
    // Direct connection — assumes THIS device is on the same Tailscale
    // network as the farm PC acting as a subnet router. No proxy, no
    // URL rewriting, no JS shims needed — it's a real network path.
    url = 'http://' + w.ip + '/';

    // A page served over HTTPS may not navigate to a plain-HTTP address.
    // Browsers block it as mixed content, and an installed app (PWA)
    // typically does so with NO error, NO page and nothing in the UI —
    // the tap simply appears to do nothing at all. That silent failure
    // is exactly what this check turns into an explanation.
    if (location.protocol === 'https:') {
      showWebUiFallback(w, url,
        'Tailscale mode is ON for this device, which opens the miner at ' + url + ' over plain HTTP. '
        + 'This app is running over HTTPS, so the browser blocks that — silently, which is why nothing happened. '
        + 'Turn Tailscale mode OFF in Settings → Web Login to use the agent tunnel instead (works on any device, '
        + 'nothing to install), or open the link below manually.');
      return;
    }
  } else {
    if(!w.farm_id){ toast('This miner has no farm assigned — cannot tunnel', 'var(--red)'); return; }
    const token = localStorage.getItem('ekl_token');
    if(!token){ toast('Not logged in', 'var(--red)'); return; }
    url = API_BASE + '/api/webui/' + encodeURIComponent(w.farm_id) + '/' + encodeURIComponent(w.ip) + '/?token=' + encodeURIComponent(token);
  }

  openExternal(w, url);
}

// Opening an external page from an INSTALLED app (PWA) is the awkward
// case: the miner UI lives on the backend's domain, which is outside the
// installed app's scope, and a plain location.href to an out-of-scope
// origin can be dropped by the launcher with no error and no visible
// change — the button just looks dead.
//
// So this tries the approaches in order of how well they survive that,
// and if none of them visibly worked, it shows a tappable link rather
// than leaving the person staring at an unchanged screen.
function openExternal(w, url) {
  const standalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches
                  || window.navigator.standalone === true;

  // In an ORDINARY browser tab, navigate this screen and nothing else.
  // A single click only earns permission to open one window, so trying
  // an anchor AND window.open meant the browser suppressed one of them
  // — and which one it suppressed decided whether anything happened at
  // all. Navigating directly is what worked here for months; it is the
  // installed-app case that needs the special handling below.
  if (!standalone) {
    toast('Opening ' + (w.name || w.ip) + ' — use Back to return', 'var(--cyan)');
    window.location.href = url;
    return;
  }

  // Installed app: the miner's page lives outside the app's scope, and
  // navigating there can be dropped silently by the launcher. An anchor
  // click is the form an installed app honours, handing the URL to the
  // browser. rel keeps noopener (safe) but NOT noreferrer, so the page
  // still sends a Referer — the tunnel needs it to resolve a
  // parent-relative request back to the right miner.
  try {
    const a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function(){ try { a.remove(); } catch(e){} }, 1000);
  } catch(e) {}

  // No reliable way to confirm the browser actually came to the front,
  // so offer the link either way. If it did open, this panel is simply
  // behind it and gets dismissed later.
  showWebUiFallback(w, url,
    'Opening ' + (w.name || w.ip) + ' in your browser. If nothing appeared, your installed app blocked it — '
    + 'tap the link below to open it manually.');
}

// A visible, tappable way out. Anything that can't be opened
// automatically ends up here, so a tap can never silently do nothing.
function showWebUiFallback(w, url, message) {
  const existing = document.getElementById('webuiFallback');
  if (existing) existing.remove();

  const wrap = document.createElement('div');
  wrap.id = 'webuiFallback';
  wrap.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;background:var(--s1);'
    + 'border-top:2px solid var(--cyan);padding:16px 16px calc(16px + env(safe-area-inset-bottom));'
    + 'box-shadow:0 -8px 24px rgba(0,0,0,.5);max-height:70vh;overflow-y:auto';
  wrap.innerHTML =
      '<div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:10px">'
    +   '<div style="font-family:Orbitron,sans-serif;font-size:12px;font-weight:700;color:var(--cyan);flex:1">'
    +     '&#x1F310; ' + escHtml(w.name || w.ip)
    +   '</div>'
    +   '<button onclick="document.getElementById(\'webuiFallback\').remove()" '
    +     'style="background:none;border:1px solid var(--b1);color:var(--mute);border-radius:4px;'
    +     'padding:4px 10px;font-size:14px;cursor:pointer;line-height:1">&#x2715;</button>'
    + '</div>'
    + '<div style="font-size:11px;color:var(--txt);line-height:1.6;margin-bottom:12px">' + escHtml(message) + '</div>'
    + '<a href="' + escAttr(url) + '" target="_blank" rel="noopener noreferrer" '
    +   'style="display:block;text-align:center;background:var(--cyan);color:#001018;font-weight:700;'
    +   'padding:12px;border-radius:6px;text-decoration:none;font-size:13px">Open miner Web UI &#x2197;</a>'
    + '<div style="font-size:9px;color:var(--mute);margin-top:8px;word-break:break-all;font-family:Share Tech Mono,monospace">'
    +   escHtml(url.replace(/token=[^&]+/, 'token=…')) + '</div>';
  document.body.appendChild(wrap);
}

// ── Miner logs: View / Download ─────────────────────────────────
// The agent already fetches the miner's log (/cgi-bin/log.cgi, the same
// text the miner's own "Current Log" page shows) and sends it back in the
// reply's `logs` field. These two buttons used to go through doAction(),
// which only shows a "… sent to <miner>" toast — so the log arrived and
// was thrown away, and the person only ever saw "Sending fetchlogs…".
function requestMinerLog(w) {
  const token = localStorage.getItem('ekl_token');
  return fetch(API_BASE + '/api/actions/fetchlogs', {
    method: 'POST',
    headers: {'Content-Type':'application/json','Authorization':'Bearer ' + (token||'')},
    body: JSON.stringify({ ip: w.ip, farm_id: w.farm_id, worker_id: w.id })
  }).then(function(r){
    return r.text().then(function(text){
      let d;
      try { d = JSON.parse(text); }
      catch(e) { throw new Error('Server returned an unexpected response (HTTP ' + r.status + ')'); }
      if (!d.ok) throw new Error(d.error || 'Could not retrieve logs from this miner');
      if (!d.logs) throw new Error('The miner answered, but sent no log text');
      return String(d.logs);
    });
  });
}

function minerLogFileName(w) {
  const d = new Date(), p = function(n){ return String(n).padStart(2, '0'); };
  const stamp = d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes());
  const who = String(w.name || w.ip || 'miner').replace(/[^A-Za-z0-9._-]+/g, '_');
  return who + '_' + String(w.ip || '').replace(/\./g, '-') + '_log_' + stamp + '.txt';
}

function saveMinerLog(w, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = minerLogFileName(w); a.style.display = 'none';
  document.body.appendChild(a); a.click();
  setTimeout(function(){ URL.revokeObjectURL(url); try { a.remove(); } catch(e){} }, 2000);
}

function downloadMinerLog(w) {
  toast('Fetching log from ' + (w.name || w.ip) + '…', 'var(--cyan)');
  requestMinerLog(w)
    .then(function(text){ saveMinerLog(w, text); toast('✓ Log saved — ' + minerLogFileName(w), 'var(--green)'); })
    .catch(function(e){ toast('✗ ' + e.message, 'var(--red)'); });
}

var _logViewer = null;   // { w, text, timer }
function closeMinerLog() {
  if (_logViewer && _logViewer.timer) clearInterval(_logViewer.timer);
  _logViewer = null;
  const el = document.getElementById('minerLogViewer');
  if (el) el.remove();
}

function viewMinerLog(w) {
  closeMinerLog();
  _logViewer = { w: w, text: '', timer: null };

  const wrap = document.createElement('div');
  wrap.id = 'minerLogViewer';
  wrap.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.7);display:flex;'
    + 'align-items:center;justify-content:center;padding:12px';
  const btn = 'background:none;border:1px solid var(--b1);color:var(--txt);border-radius:4px;'
    + 'padding:6px 10px;font-size:11px;cursor:pointer;white-space:nowrap';
  wrap.innerHTML =
      '<div style="background:var(--s1);border:1px solid var(--b1);border-radius:8px;width:100%;max-width:1100px;'
    +   'height:100%;max-height:90vh;display:flex;flex-direction:column;overflow:hidden">'
    +   '<div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--b1)">'
    +     '<div style="flex:1;min-width:160px">'
    +       '<div style="font-family:Orbitron,sans-serif;font-size:12px;font-weight:700;color:var(--cyan)">' + escHtml(w.name || w.ip) + ' — Miner Log</div>'
    +       '<div id="minerLogStatus" style="font-size:10px;color:var(--mute);margin-top:2px">Fetching…</div>'
    +     '</div>'
    +     '<input id="minerLogFilter" placeholder="Filter lines…" style="background:var(--s2,#0b1622);border:1px solid var(--b1);'
    +       'color:var(--txt);border-radius:4px;padding:6px 8px;font-size:11px;width:150px">'
    +     '<label style="font-size:10px;color:var(--mute);display:flex;align-items:center;gap:4px;cursor:pointer">'
    +       '<input type="checkbox" id="minerLogAuto"> Auto-refresh</label>'
    +     '<button id="minerLogRefresh" style="' + btn + '">&#x21bb; Refresh</button>'
    +     '<button id="minerLogCopy" style="' + btn + '">Copy</button>'
    +     '<button id="minerLogSave" style="' + btn + '">&#x2913; Download</button>'
    +     '<button id="minerLogClose" style="' + btn + ';color:var(--mute)">&#x2715;</button>'
    +   '</div>'
    +   '<pre id="minerLogText" style="flex:1;margin:0;padding:10px 12px;overflow:auto;font-family:\'Share Tech Mono\',monospace;'
    +     'font-size:11px;line-height:1.5;color:var(--txt);white-space:pre-wrap;word-break:break-word"></pre>'
    + '</div>';
  document.body.appendChild(wrap);

  const pre = document.getElementById('minerLogText');
  const status = document.getElementById('minerLogStatus');
  const filter = document.getElementById('minerLogFilter');

  function render(keepPlace) {
    if (!_logViewer) return;
    const q = filter.value.trim().toLowerCase();
    const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
    const lines = _logViewer.text.split('\n');
    const shown = q ? lines.filter(function(l){ return l.toLowerCase().indexOf(q) !== -1; }) : lines;
    pre.textContent = shown.join('\n') || (q ? '(no lines match "' + filter.value + '")' : '');
    // The newest lines are at the bottom — start there, and on refresh
    // stay there unless the person has scrolled up to read something.
    if (!keepPlace || atBottom) pre.scrollTop = pre.scrollHeight;
  }

  let loading = false;
  function load(isRefresh) {
    if (loading || !_logViewer) return;
    loading = true;
    status.textContent = isRefresh ? 'Refreshing…' : 'Fetching…';
    requestMinerLog(w).then(function(text){
      if (!_logViewer) return;
      _logViewer.text = text;
      const n = text.split('\n').length;
      status.textContent = w.ip + ' · ' + n + ' lines · fetched ' + new Date().toLocaleTimeString();
      render(isRefresh);
    }).catch(function(e){
      if (!_logViewer) return;
      status.textContent = '✗ ' + e.message;
      if (!_logViewer.text) pre.textContent = e.message;
    }).then(function(){ loading = false; });
  }

  filter.addEventListener('input', function(){ render(false); });
  document.getElementById('minerLogRefresh').onclick = function(){ load(true); };
  document.getElementById('minerLogClose').onclick = closeMinerLog;
  wrap.addEventListener('click', function(e){ if (e.target === wrap) closeMinerLog(); });
  document.getElementById('minerLogSave').onclick = function(){
    if (!_logViewer || !_logViewer.text) { toast('Nothing to save yet', 'var(--warn)'); return; }
    saveMinerLog(w, _logViewer.text);
  };
  document.getElementById('minerLogCopy').onclick = function(){
    if (!_logViewer || !_logViewer.text) return;
    const done = function(){ toast('✓ Log copied', 'var(--green)'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(_logViewer.text).then(done).catch(function(){ toast('✗ Copy blocked by the browser', 'var(--red)'); });
    }
  };
  // Every 15 s — each refresh is one request to the miner through the
  // farm agent, so this stays gentle on the miner's small web server.
  document.getElementById('minerLogAuto').onchange = function(e){
    if (!_logViewer) return;
    if (_logViewer.timer) { clearInterval(_logViewer.timer); _logViewer.timer = null; }
    if (e.target.checked) _logViewer.timer = setInterval(function(){ load(true); }, 15000);
  };

  load(false);
}

function doAction(action, wid){
  const w = workers.find(function(x){ return x.id === (wid || activeWid); });
  if(!w){ toast('No miner selected', 'var(--warn)'); return; }

  if (action === 'fetchlogs')    { viewMinerLog(w); return; }
  if (action === 'downloadlogs') { downloadMinerLog(w); return; }

  // worker_id here means "which miner to look up" — kept consistent
  // with the backend's lookup field. Parameterized actions add their
  // OWN differently-named fields below so nothing collides with this.
  var body = { ip: w.ip, farm_id: w.farm_id, worker_id: w.id };

  if (action === 'setworkerid') {
    var newWid = document.getElementById('newWid');
    if (!newWid || !newWid.value.trim()) { toast('Enter a new Worker ID first', 'var(--warn)'); return; }
    body.new_worker_id = newWid.value.trim();
  } else if (action === 'setpool') {
    var pUrl1 = document.getElementById('pUrl1'), pUser1 = document.getElementById('pUser1');
    if (!pUrl1 || !pUrl1.value.trim() || !pUser1 || !pUser1.value.trim()) { toast('Enter at least the primary pool URL and worker', 'var(--warn)'); return; }
    body.pool_url  = pUrl1.value.trim();
    body.pool_user = pUser1.value.trim();
    var pUrl2 = document.getElementById('pUrl2'), pUrl3 = document.getElementById('pUrl3');
    if (pUrl2 && pUrl2.value.trim()) body.pool_url2 = pUrl2.value.trim();
    if (pUrl3 && pUrl3.value.trim()) body.pool_url3 = pUrl3.value.trim();
  } else if (action === 'overclock') {
    var powerMode = document.getElementById('powerMode'), freqPct = document.getElementById('freqPct'), fanPct = document.getElementById('fanPct');
    body.mode     = powerMode ? powerMode.value : 'normal';
    body.freq_pct = freqPct  ? parseInt(freqPct.value)  : 100;
    body.fan_pct  = fanPct   ? parseInt(fanPct.value)   : 80;
  } else if (action === 'factoryreset') {
    if (!confirm('Factory reset ' + w.name + '? This wipes all settings and cannot be undone.')) return;
    body.confirmed = true;
  } else if (action === 'firmware') {
    var fwUrl = document.getElementById('fwUrl'), fwVer = document.getElementById('fwVer');
    if (!fwUrl || !fwUrl.value.trim()) { toast('Enter a firmware URL or file path first', 'var(--warn)'); return; }
    if (!confirm('Upgrade firmware on ' + w.name + '? Do not power off during the process.')) return;
    body.firmware_url = fwUrl.value.trim();
    body.firmware_version = fwVer ? fwVer.value.trim() : '';
  } else if (action === 'delete') {
    if (!confirm('Permanently remove ' + w.name + ' from the fleet? This cannot be undone.')) return;
  } else if (action === 'disable') {
    // The reason is what makes this useful weeks later — "why is this
    // one out?" is the question the fleet list can't answer on its own.
    var reason = prompt('Why is ' + w.name + ' being taken out of service?\n(e.g. PSU failed, hashboard 2 dead, sent to repair)', 'Taken for repair');
    if (reason === null) return;                       // cancelled
    body.reason = reason.trim() || 'Taken for repair';
  } else if (action === 'enable') {
    if (!confirm('Return ' + w.name + ' to service? It will count in fleet totals and alerts again.')) return;
  }

  const token = localStorage.getItem('ekl_token');
  toast('Sending ' + action + ' to ' + w.name + '...', 'var(--cyan)');

  fetch(API_BASE + '/api/actions/' + action, {
    method: 'POST',
    headers: {'Content-Type':'application/json','Authorization':'Bearer ' + (token||'')},
    body: JSON.stringify(body)
  })
  .then(function(r){
    return r.text().then(function(text){
      let d;
      try { d = JSON.parse(text); }
      catch(e) { throw new Error('Server returned an unexpected response (HTTP ' + r.status + ') — this action may not be available yet'); }
      return d;
    });
  })
  .then(function(d){
    if(d.ok) {
      toast('✓ ' + (d.message || (action + ' sent to ' + w.name)), 'var(--green)');
      if (action === 'delete') { workers = workers.filter(function(x){ return x.id !== w.id; }); saveFleet(); closeCtrl(); renderWorkers(); }
      // The server has saved it; this device's copy must match straight
      // away. Only the toast used to happen, so the machine never showed
      // as disabled here (not under the Disabled filter, not in the
      // dashboard's repair count, drawn red like an offline machine) —
      // and this device's stale copy could later push it back to enabled.
      if (action === 'disable') {
        w.disabled = true; w.disabled_reason = body.reason; w.disabled_at = new Date().toISOString();
        w.status = 'disabled'; w.hashrate = 0; w.hr_display = '—';
      }
      if (action === 'enable') {
        w.disabled = false; w.disabled_reason = null; w.disabled_at = null; w.status = 'offline';
      }
      if (action === 'disable' || action === 'enable') {
        saveFleet(); _workersHash = '';
        try { refreshCtrl(); } catch(e) {}
        try { renderAll(); } catch(e) {}
      }
    } else if (action === 'delete' && /not found/i.test(d.error || '')) {
      // The server has no such record — it only exists on this device
      // (an old local copy). Removing it here is all there is to do.
      workers = workers.filter(function(x){ return x.id !== w.id; });
      customers.forEach(function(c){ if (Array.isArray(c.miners)) c.miners = c.miners.filter(function(x){ return x !== w.id; }); });
      saveFleet(); _workersHash = ''; _fleetHash = '';
      try { closeCtrl(); } catch(e) {}
      try { renderAll(); } catch(e) { renderWorkers(); }
      toast('✓ ' + w.name + ' removed (it was only on this device)', 'var(--green)');
    } else if (/worker not found/i.test(d.error || '')) {
      toast('✗ ' + w.name + ' is not on the server — it is an old copy on this device. Use Remove to clear it.', 'var(--red)');
    } else {
      toast('✗ ' + (d.error || 'Failed'), 'var(--red)');
    }
  })
  .catch(function(e){ toast('✗ ' + e.message, 'var(--red)'); });
}


function addToFleetDirect(ip, model, farmId, farmName){
  const miner   = (_lastScanResults && _lastScanResults[ip]) ? _lastScanResults[ip] : {};
  const existing= workers.find(function(w){ return w.ip === ip; });
  workers = workers.filter(function(w){ return w.ip !== ip; });
  var algo    = miner.algo || getAlgoFromModel(model || miner.model || '');
  var brand   = miner.brand || detectBrand(miner.model || model);
  var ghAlgos = ['Scrypt','KHeavyHash','X11','Blake2B','Ethash','Equihash'];
  var hrUnit  = miner.hr_unit || (ghAlgos.includes(algo) ? 'GH/s' : 'TH/s');
  var hrDisp  = (miner.hr_display && miner.hr_display !== '—') ? miner.hr_display : (miner.hashrate > 0 ? miner.hashrate.toFixed(2) + ' ' + hrUnit : '—');

  // If this machine was already in the fleet, keep its locked/manual
  // Serial and MAC (and the customer/disabled state) instead of wiping
  // them out just because it's being re-added via a fresh scan.
  const keptSerial = existing && (existing.serial_manual || existing.serial) ? existing.serial : (miner.serial || null);
  const keptMac    = existing && (existing.mac_manual    || existing.mac)    ? existing.mac    : (miner.mac    || null);

  workers.push({
    id: stableWorkerId({ mac: keptMac, serial: keptSerial, ip: ip }),
    name: miner.worker || ip.replace(/\./g, '-'),
    worker_id: miner.worker_id || miner.worker || '—',   // full wallet.worker string
    mac: keptMac, mac_manual: existing?.mac_manual || false,
    serial: keptSerial, serial_manual: existing?.serial_manual || false,
    model: miner.model || model || 'ASIC Miner',
    brand: brand, algo: algo, ip: ip,
    hashrate: miner.hashrate || 0, hr_unit: hrUnit, hr_display: (miner.hashrate > 0) ? hrDisp : '—',
    temp: miner.temp || 0, fan: miner.fan || 0, power: miner.power || 0,
    status: (miner.hashrate > 0) ? 'online' : 'offline', pool: miner.pool || '—', pool_url: miner.pool || '',
    pool_user: miner.worker || '', uptime: miner.uptime || '—',
    farm: farmName, farm_id: farmId,
    cid: existing?.cid || '', disabled: existing?.disabled || false, led: false,
    firmware: miner.firmware || '—',
    accepted: miner.accepted || 0, rejected: miner.rejected || 0,
    hw_errors: miner.hw_errors || 0, source: 'scan',
    added_at: existing?.added_at || new Date().toISOString()
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
