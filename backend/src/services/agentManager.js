// ============================================================
// AGENT MANAGER — tracks connected farm agents
// ============================================================
const connectedAgents = new Map();

// ── Riding out brief connection drops ───────────────────────
// A farm whose internet blips (seen at Ghummadh: dropped every few
// minutes, reconnecting within seconds) used to have EVERY machine
// marked offline on each drop, and the short first poll after the
// reconnect marked most of them offline again. That produced false
// "100+ machines offline" alarms while nothing on site was actually down.
//
// 1) Disconnect grace: machines are only marked offline if the agent
//    stays away for DISCONNECT_GRACE_MS. A reconnect inside that window
//    cancels it — the next poll brings fresh readings anyway.
// 2) Short-poll guard: a poll that finds fewer machines than usual right
//    after a reconnect, or >10% fewer at any time, still updates the ones it
//    found, but doesn't mark the missing ones offline. A genuine outage
//    is applied once it has persisted past SHORT_POLL_CONFIRM_MS.
const DISCONNECT_GRACE_MS   = 2 * 60 * 1000;
const RECONNECT_SETTLE_MS   = 3 * 60 * 1000;
const SHORT_POLL_RATIO      = 0.9;            // > 10% of the usual machines missing = "short"
const SHORT_POLL_CONFIRM_MS = 3 * 60 * 1000;
const pendingClears = new Map();   // farm_id -> timer
const pollState     = new Map();   // farm_id -> { typical, shortSince }

function decideOfflinePass(farmId, count, connectedAt) {
  const now = Date.now();
  const st = pollState.get(farmId) || { typical: 0, shortSince: 0 };
  const sinceConnect = connectedAt ? now - new Date(connectedAt).getTime() : Infinity;
  const settling = sinceConnect < RECONNECT_SETTLE_MS;
  // Right after a reconnect ANY drop is held back until confirmed;
  // otherwise only a drop of more than 10%.
  const short = st.typical > 0 && (count < st.typical * SHORT_POLL_RATIO || (settling && count < st.typical));
  if (!short) {
    pollState.set(farmId, { typical: count, shortSince: 0 });
    return { skip: false };
  }
  if (!st.shortSince) st.shortSince = now;
  pollState.set(farmId, st);
  const unconfirmed = now - st.shortSince < SHORT_POLL_CONFIRM_MS;
  if (settling || unconfirmed) {
    return { skip: true, why: `${count} of usual ${st.typical} answered` + (settling ? ' just after reconnect' : ' — waiting to confirm') };
  }
  // Persisted long enough: it's real. Accept it as the new normal.
  pollState.set(farmId, { typical: count, shortSince: 0 });
  return { skip: false, confirmed: true };
}

// ── Duplicate-agent detection ───────────────────────────────
// Replacing a farm's existing connection is correct when the old socket
// is a stale one the agent has already given up on. It is exactly wrong
// when TWO agent processes share one farm id: each replacement kicks the
// other off, the kicked one reconnects, and they trade places forever.
// Seen in production at one swap every 3.6s — 104 reconnections in six
// minutes, which drowned the log and kept re-registering the farm
// non-stop.
//
// So replacements are counted. A couple are normal (a genuine
// reconnect); a steady stream means duplicates, and then the sitting
// connection is kept and the newcomer is turned away instead.
const REPLACE_WINDOW_MS = 60 * 1000;
const REPLACE_LIMIT     = 4;          // replacements per minute before we call it a duplicate
const replacementLog    = new Map();  // farm_id -> [timestamps]
const duplicateWarned   = new Map();  // farm_id -> last warning time

function noteReplacement(farmId) {
  const now = Date.now();
  const hits = (replacementLog.get(farmId) || []).filter(t => now - t < REPLACE_WINDOW_MS);
  hits.push(now);
  replacementLog.set(farmId, hits);
  return hits.length;
}

// Returns true if this farm is currently flapping between duplicates.
function isDuplicateStorm(farmId) {
  const now = Date.now();
  const hits = (replacementLog.get(farmId) || []).filter(t => now - t < REPLACE_WINDOW_MS);
  replacementLog.set(farmId, hits);
  return hits.length >= REPLACE_LIMIT;
}

function warnDuplicateOnce(farmId, farmName, hostname) {
  const now = Date.now();
  const last = duplicateWarned.get(farmId) || 0;
  if (now - last < 5 * 60 * 1000) return;   // at most one warning per farm per 5 min
  duplicateWarned.set(farmId, now);
  console.warn(
    `[AGENT] ⚠ DUPLICATE AGENT for farm "${farmId}" (${farmName}). ` +
    `More than one agent process is connecting with this same FARM_ID — they kick each other off in a loop. ` +
    `Newest attempt came from host "${hostname}". Keeping the connection already in place and refusing the extra one. ` +
    `Fix: make sure only ONE agent runs per farm (check for a second agent.js or a second update-check.js on that PC), ` +
    `or give the other machine its own FARM_ID.`
  );
}

// Returns false when the caller must NOT wire this socket up — it has
// already been closed as a duplicate.
function registerAgent(ws, info) {
  // If this farm already has a socket registered, it's a stale one that
  // hasn't finished dying yet — the agent only opens a second connection
  // because it believes the first is gone. Close the old one explicitly
  // so its close event fires NOW, while the map still points at it,
  // rather than arriving later and deleting this new registration
  // (see unregisterAgent — that race is what left agents showing offline
  // in the UI while their own logs said "connected").
  const existing = connectedAgents.get(info.farm_id);
  if (existing && existing.ws !== ws) {
    // Already flapping — keep who we have and turn this one away, so the
    // two processes stop trading places. The server-side keepalive still
    // reaps the sitting connection within ~32s if it is genuinely dead,
    // and the farm recovers on the next attempt.
    if (isDuplicateStorm(info.farm_id) && existing.ws.readyState === 1) {
      warnDuplicateOnce(info.farm_id, info.farm_name, info.hostname || 'unknown');
      try {
        ws.close(4003, 'Another agent is already connected with this FARM_ID');
      } catch(e) {}
      return false;
    }

    const count = noteReplacement(info.farm_id);
    console.log(`[AGENT] ${info.farm_name}: replacing previous connection` +
                (count > 1 ? ` (${count} replacements in the last minute)` : ''));
    try { existing.ws.close(4002, 'Superseded by a newer connection'); } catch(e) {}
    try { existing.ws.terminate(); } catch(e) {}
  }

  // Back inside the grace window — don't mark its machines offline.
  const pendingClear = pendingClears.get(info.farm_id);
  if (pendingClear) { clearTimeout(pendingClear); pendingClears.delete(info.farm_id); }

  const agent = {
    farm_id:       info.farm_id,
    farm_name:     info.farm_name,
    subnet:        info.subnet        || '192.168.1.0/24',
    hostname:      info.hostname      || 'unknown',
    agent_version: info.agent_version || '1.0.0',
    connected_at:  new Date().toISOString(),
    last_seen:     new Date().toISOString(),
    online:        true,
    miner_count:   0,
    ws,
  };

  connectedAgents.set(info.farm_id, agent);
  console.log(`[AGENT] Registered: ${info.farm_name} | Total: ${connectedAgents.size}`);

  // Send welcome back to agent
  try {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({
        type:    'welcome',
        message: `Ekalavya — Farm ${info.farm_name} registered`,
        farm_id: info.farm_id,
      }));
    }
  } catch(e) {}

  // Broadcast to frontend via websocket (lazy require avoids circular dep)
  try {
    const { broadcast } = require('../websocket');
    broadcast({ type: 'agent_connected', agent: sanitize(agent) });
  } catch(e) {}

  return true;
}

// `ws` is the socket whose close event fired. It matters: a late close
// from an OLD socket must not delete the entry belonging to the NEW one
// the agent has since opened. Without this check the agent would sit
// there with a perfectly healthy connection while the backend had no
// record of it — online in its own log, offline in the software, until
// someone restarted it by hand.
function unregisterAgent(farmId, ws) {
  const agent = connectedAgents.get(farmId);
  if (agent && ws && agent.ws !== ws) {
    console.log(`[AGENT] ${agent.farm_name}: ignoring close from a superseded connection (current one is still live)`);
    return;
  }
  if (agent) {
    console.log(`[AGENT] Disconnected: ${agent.farm_name}`);
    connectedAgents.delete(farmId);
    try {
      const { broadcast } = require('../websocket');
      broadcast({ type: 'agent_disconnected', farm_id: farmId });
    } catch(e) {}
    // The agent is gone — no more polls will arrive to clear stale
    // readings, so they're cleared rather than left showing last-known
    // hashrate/temp for machines nobody can see. But only if it STAYS
    // gone: a blip that reconnects within DISCONNECT_GRACE_MS leaves the
    // readings alone (see the note at the top of this file).
    const prev = pendingClears.get(farmId);
    if (prev) clearTimeout(prev);
    const farmName = agent.farm_name;
    pendingClears.set(farmId, setTimeout(() => {
      pendingClears.delete(farmId);
      if (connectedAgents.has(farmId)) return;   // came back after all
      console.log(`[AGENT] ${farmName} still disconnected after ${DISCONNECT_GRACE_MS / 60000} min — marking its machines offline`);
      pollState.delete(farmId);
      try {
        require('./db').clearFarmReadings(farmId).catch(e => console.error('[AGENT] clearFarmReadings error:', e.message));
      } catch(e) {}
    }, DISCONNECT_GRACE_MS));
  }
}

function handleAgentMessage(farmId, msg) {
  // Wraps the ENTIRE handler — any error anywhere in here (now or in
  // anything added later) is caught and logged per-farm, and can
  // never propagate up to crash the shared backend process that
  // every other farm's connection also depends on.
  try {
    const agent = connectedAgents.get(farmId);
    if (!agent) return;

    agent.last_seen   = new Date().toISOString();
    agent.miner_count = msg.miner_count || msg.miners?.length || agent.miner_count;

    // Heartbeat — reply to agent
    if (msg.type === 'heartbeat' && agent.ws.readyState === 1) {
      try { agent.ws.send(JSON.stringify({ type: 'heartbeat_ack' })); } catch(e) {}
    }

    // Web UI tunnel — resolve the matching pending request
    if (msg.type === 'webui_proxy_response') {
      resolveWebuiResponse(msg);
      return; // nothing else needs this message
    }

    // Miner action tunnel — resolve the matching pending request
    if (msg.type === 'action_response') {
      resolveActionResponse(msg);
      return;
    }

    // Broadcast scan events directly to frontend (no wrapping)
    if (['scan_found','scan_progress','poll_result','scan_update'].includes(msg.type)) {
      try {
        const { broadcast } = require('../websocket');
        broadcast({ ...msg, farm_id: farmId }); // spread msg directly — frontend reads msg.miner etc.
        console.log(`[AGENT→FRONTEND] ${msg.type} from ${farmId}`);
      } catch(e) { console.error('[BROADCAST]', e.message); }
    }

    // Persist auto-poll results into the fleet — this is what makes new
    // machines appear automatically and unplugged ones show offline,
    // independent of whether anyone has the app open right now.
    if (msg.type === 'poll_result' && Array.isArray(msg.miners)) {
      const db = require('./db');
      const d = decideOfflinePass(farmId, msg.miners.length, agent.connected_at);
      if (d.skip) console.log(`[POLL→DB] ${farmId}: short poll (${d.why}) — updating those, not marking the rest offline yet`);
      if (d.confirmed) console.log(`[POLL→DB] ${farmId}: drop to ${msg.miners.length} machines has persisted — applying it`);
      db.upsertWorkersByIp(farmId, msg.miners, { skipMarkOffline: !!d.skip }).then(ok => {
        if (ok) console.log(`[POLL→DB] ${farmId}: ${msg.miners.length} miners persisted`);
      }).catch(e => console.error('[POLL→DB] error:', e.message));
    }
  } catch(e) {
    console.error(`[AGENT][${farmId}] handleAgentMessage error (isolated — other farms unaffected):`, e.message);
  }
}

function getAgents() {
  return [...connectedAgents.values()].map(sanitize);
}

function getAgent(farmId) {
  const a = connectedAgents.get(farmId);
  return a ? sanitize(a) : null;
}

function sendToAgent(farmId, payload) {
  const agent = connectedAgents.get(farmId);
  if (!agent || agent.ws.readyState !== 1) return false;
  try { agent.ws.send(JSON.stringify(payload)); return true; } catch(e) { return false; }
}

// ── Web UI tunnel — request/response matching ──────────────
// The agent proxies an HTTP request to a miner's local web UI and sends
// the raw response back over the same WebSocket. Since WebSocket is
// fire-and-forget, we track each outstanding request by a unique ID and
// resolve/reject a Promise when the matching response message arrives.
const pendingWebuiRequests = new Map(); // request_id -> { resolve, reject, timer }

function sendWebuiRequest(farmId, ip, method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const agent = connectedAgents.get(farmId);
    if (!agent || agent.ws.readyState !== 1) { reject(new Error(`Agent "${farmId}" not connected`)); return; }

    const request_id = 'webui-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

    // This budget has to cover QUEUE TIME at the agent, not just the
    // miner's own response time. Requests to a single miner are served
    // a few at a time, so on a page pulling dozens of files the later
    // ones wait their turn first. At the old 12s the backend gave up
    // while those requests were still sitting in the queue, unstarted —
    // so the tail of every large page failed no matter how healthy the
    // miner was. That's why an Antminer dashboard showed its readings
    // (early requests) but never its language file (a later one), and
    // why the page felt slow: the browser was waiting out timeouts.
    const TTL_MS = 30000;
    const timer = setTimeout(() => {
      pendingWebuiRequests.delete(request_id);
      reject(new Error('Miner did not respond in time (is it powered on and reachable?)'));
    }, TTL_MS);

    pendingWebuiRequests.set(request_id, { resolve, reject, timer });

    try {
      agent.ws.send(JSON.stringify({
        // ttl_ms lets the agent drop a request whose caller has already
        // given up, instead of spending the miner's limited capacity on
        // a response nobody will read. Sent as a duration rather than a
        // deadline so it doesn't depend on the farm PC's clock matching
        // the server's.
        type: 'webui_proxy_request', request_id, ip, method, path, headers, body, ttl_ms: TTL_MS,
      }));
    } catch(e) {
      clearTimeout(timer);
      pendingWebuiRequests.delete(request_id);
      reject(e);
    }
  });
}

function resolveWebuiResponse(msg) {
  const pending = pendingWebuiRequests.get(msg.request_id);
  if (!pending) return; // timed out already, or unknown ID — ignore
  clearTimeout(pending.timer);
  pendingWebuiRequests.delete(msg.request_id);
  pending.resolve(msg);
}

// ── Miner control actions — same request/response tunnel pattern
// as the Web UI proxy above, since the backend has no direct network
// path to a miner's private farm IP either. ─────────────────────────
const pendingActionRequests = new Map();

function sendActionRequest(farmId, ip, action, params) {
  return new Promise((resolve, reject) => {
    const agent = connectedAgents.get(farmId);
    if (!agent || agent.ws.readyState !== 1) {
      console.log(`[ACTION-TUNNEL] ✗ Agent "${farmId}" not connected (readyState: ${agent ? agent.ws.readyState : 'no agent'})`);
      reject(new Error(`Agent "${farmId}" not connected`)); return;
    }

    const request_id = 'action-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const timer = setTimeout(() => {
      pendingActionRequests.delete(request_id);
      console.log(`[ACTION-TUNNEL] ✗ Timeout — no response for ${action} → ${ip} (request_id: ${request_id})`);
      reject(new Error('Miner did not respond in time (is it powered on and reachable?)'));
    }, 15000);

    pendingActionRequests.set(request_id, { resolve, reject, timer });

    try {
      agent.ws.send(JSON.stringify({ type: 'action_request', request_id, ip, action, params }));
      console.log(`[ACTION-TUNNEL] → Sent ${action} → farm=${farmId} ip=${ip} (request_id: ${request_id})`);
    } catch(e) {
      clearTimeout(timer);
      pendingActionRequests.delete(request_id);
      console.log(`[ACTION-TUNNEL] ✗ ws.send() threw: ${e.message}`);
      reject(e);
    }
  });
}

function resolveActionResponse(msg) {
  console.log(`[ACTION-TUNNEL] ← Response received for request_id ${msg.request_id} | ok=${msg.ok}`);
  const pending = pendingActionRequests.get(msg.request_id);
  if (!pending) { console.log(`[ACTION-TUNNEL] ✗ No pending request matches this ID — already timed out?`); return; }
  clearTimeout(pending.timer);
  pendingActionRequests.delete(msg.request_id);
  pending.resolve(msg);
}

function sanitize(a) {
  const { ws, ...rest } = a;
  const secs = Math.floor((Date.now() - new Date(a.last_seen)) / 1000);
  return {
    ...rest,
    last_seen_ago: secs < 60 ? 'Just now' : secs < 3600 ? Math.floor(secs/60)+' min ago' : Math.floor(secs/3600)+'h ago',
  };
}

// ── Manually remove an agent ──────────────────────────────
function removeAgent(farmId) {
  const agent = connectedAgents.get(farmId);
  if (agent) {
    try { if (agent.ws) agent.ws.close(); } catch(e) {}
    connectedAgents.delete(farmId);
    return true;
  }
  return false;
}

// ── Clean up stale agents (not seen for 90s) ──────────────
setInterval(() => {
  const cutoff = Date.now() - 90 * 1000;
  connectedAgents.forEach((agent, farmId) => {
    const lastSeen = new Date(agent.last_seen).getTime();
    const wsDead   = !agent.ws || agent.ws.readyState !== 1;
    if (lastSeen < cutoff || wsDead) {
      console.log(`[AGENT] Removing stale agent: ${agent.farm_name} (${farmId})`);
      connectedAgents.delete(farmId);
      try {
        const { broadcast } = require('../websocket');
        broadcast({ type: 'agent_disconnected', farm_id: farmId });
      } catch(e) {}
      try {
        require('./db').clearFarmReadings(farmId).catch(e => console.error('[AGENT] clearFarmReadings error:', e.message));
      } catch(e) {}
    }
  });
}, 30 * 1000);

module.exports = {
  removeAgent, registerAgent, unregisterAgent, handleAgentMessage, getAgents, getAgent, sendToAgent, sendWebuiRequest, sendActionRequest };
