const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'ekalavya-secret-change-me';

// Demo users — change passwords before going live
const USERS = [
  { id: 'admin-1',  username: 'admin',  password: 'admin123',  role: 'admin'       },
  { id: 'tech-1',   username: 'tech',   password: 'tech123',   role: 'technician'  },
  { id: 'view-1',   username: 'viewer', password: 'view123',   role: 'viewer'      },
];

const CUSTOMERS = [
  { id: 'cust-001', email: 'ahmad@example.com', password: 'ahmad123', name: 'Ahmad Al-Farsi', role: 'customer' },
  { id: 'cust-002', email: 'sarah@example.com', password: 'sarah123', name: 'Sarah Chen',     role: 'customer' },
];

// POST /api/auth/login
router.post('/login', (req, res) => {
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

  // Check customers
  const cust = CUSTOMERS.find(c =>
    (c.email === username || c.email === email) && c.password === password
  );
  if (cust) {
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
