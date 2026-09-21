const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const db      = require('../services/db');
const { verifyPassword } = require('../services/passwords');

const JWT_SECRET = process.env.JWT_SECRET || 'ekalavya-secret-change-me';

// Demo users — change passwords before going live
const USERS = [
  { id: 'admin-1',  username: 'admin',  password: 'admin123',  role: 'admin'       },
  { id: 'tech-1',   username: 'tech',   password: 'tech123',   role: 'technician'  },
  { id: 'view-1',   username: 'viewer', password: 'view123',   role: 'viewer'      },
];

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, email, password } = req.body;

  // Check admin/team users
  const user = USERS.find(u =>
    (u.username === username || u.username === email) && u.password === password
  );
  if (user) {
    const token = jwt.sign(
      { id: user.id, role: user.role, name: user.username },
      JWT_SECRET,
      { expiresIn: '30d' }
    );
    return res.json({ ok: true, token, role: user.role, name: user.username });
  }

  // Check REAL team members — the ones actually created from the Team
  // Access page, not the three hardcoded demo logins above. Username
  // is matched case-insensitively (it's stored lowercased on create);
  // password is scrypt-hashed, same as customers below.
  const teamLogin = (username || email || '').trim().toLowerCase();
  if (teamLogin) {
    const team = await db.loadTeamMembers();
    const member = team.find(m => (m.username || '').toLowerCase() === teamLogin);
    if (member && member.active !== false && verifyPassword(password, member.password)) {
      const token = jwt.sign(
        { id: member.id, role: member.role || 'team', name: member.name },
        JWT_SECRET,
        { expiresIn: '30d' }
      );
      return res.json({ ok: true, token, role: member.role || 'team', name: member.name });
    }
  }

  // Check REAL customers — the ones actually created in the app,
  // not a hardcoded demo list. Passwords are stored hashed.
  const customers = await db.loadCustomers();
  const cust = customers.find(c => c.email && (c.email === username || c.email === email));
  if (cust && cust.portal && verifyPassword(password, cust.password)) {
    const token = jwt.sign(
      { id: cust.id, role: 'customer', name: cust.name },
      JWT_SECRET,
      { expiresIn: '30d' }
    );
    return res.json({ ok: true, token, role: 'customer', name: cust.name, customer_id: cust.id });
  }

  res.status(401).json({ error: 'Invalid credentials' });
});

// GET /api/auth/me
router.get('/me', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(auth.replace('Bearer ', ''), JWT_SECRET);
    res.json({ ok: true, user: decoded });
  } catch(e) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

module.exports = router;
