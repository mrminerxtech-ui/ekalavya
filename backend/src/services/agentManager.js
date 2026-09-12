// ============================================================
// AGENT MANAGER — tracks connected farm agents
// ============================================================
const connectedAgents = new Map();

function registerAgent(ws, info) {
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

function unregisterAgent(farmId) {
  const agent = connectedAgents.get(farmId);
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
  const agent = connectedAgents.get(farmId);
  if (!agent) return;

  agent.last_seen   = new Date().toISOString();
  agent.miner_count = msg.miner_count || msg.miners?.length || agent.miner_count;

  // Heartbeat — reply to agent
  if (msg.type === 'heartbeat' && agent.ws.readyState === 1) {
    try { agent.ws.send(JSON.stringify({ type: 'heartbeat_ack' })); } catch(e) {}
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
  removeAgent, registerAgent, unregisterAgent, handleAgentMessage, getAgents, getAgent, sendToAgent };
