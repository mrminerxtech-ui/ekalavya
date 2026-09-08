// ============================================================
// WEBSOCKET — Real-time push to frontend
// ============================================================
let wssInstance = null;

function initWebSocket(server, existingWss) {
  // Use the existing wss passed from server.js
  wssInstance = existingWss;

  // Heartbeat every 30s
  setInterval(() => {
    if (!wssInstance) return;
    wssInstance.clients.forEach(ws => {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
      }
    });
  }, 30000);

  console.log('[WS] WebSocket broadcast ready');
  return wssInstance;
}

function broadcast(payload) {
  if (!wssInstance) return;
  const data = JSON.stringify(payload);
  wssInstance.clients.forEach(ws => {
    if (ws.readyState === 1) ws.send(data);
  });
}

function getConnectedCount() {
  if (!wssInstance) return 0;
  return [...wssInstance.clients].filter(ws => ws.readyState === 1).length;
}

module.exports = { initWebSocket, broadcast, getConnectedCount };
