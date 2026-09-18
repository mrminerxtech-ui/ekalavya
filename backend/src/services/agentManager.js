// ============================================================
// AGENT MANAGER — tracks connected farm agents
// ============================================================
const connectedAgents = new Map();

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
    console.log(`[AGENT] ${info.farm_name}: replacing previous connection`);
    try { existing.ws.close(4002, 'Superseded by a newer connection'); } catch(e) {}
    try { existing.ws.terminate(); } catch(e) {}
  }

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
      db.upsertWorkersByIp(farmId, msg.miners).then(ok => {
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
    const timer = setTimeout(() => {
      pendingWebuiRequests.delete(request_id);
      reject(new Error('Miner did not respond in time (is it powered on and reachable?)'));
    }, 12000);

    pendingWebuiRequests.set(request_id, { resolve, reject, timer });

    try {
      agent.ws.send(JSON.stringify({
        type: 'webui_proxy_request', request_id, ip, method, path, headers, body,
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
    }
  });
}, 30 * 1000);

module.exports = {
  removeAgent, registerAgent, unregisterAgent, handleAgentMessage, getAgents, getAgent, sendToAgent, sendWebuiRequest, sendActionRequest };
