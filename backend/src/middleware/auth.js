const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-prod';
const AGENT_KEYS = (process.env.AGENT_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);

function authMiddleware(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : header;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch(e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Role check — used by actions.js and other routes
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (roles.length === 0 || roles.includes(req.user.role)) return next();
    return res.status(403).json({ error: 'Insufficient permissions' });
  };
}

function agentKeyMiddleware(req, res, next) {
  const key = req.headers['x-agent-key'] || req.query.key;
  if (AGENT_KEYS.length === 0) {
    console.warn('[AGENT] AGENT_KEYS not set — allowing all agents (dev mode)');
    return next();
  }
  if (!key || !AGENT_KEYS.includes(key)) {
    const name = req.headers['x-farm-name'] || req.headers['x-farm-id'] || 'Unknown';
    console.warn(`[AGENT] Bad key from ${name} — rejecting`);
    return res.status(403).json({ error: 'Invalid agent key' });
  }
  next();
}

module.exports = { authMiddleware, agentKeyMiddleware, requireRole };
