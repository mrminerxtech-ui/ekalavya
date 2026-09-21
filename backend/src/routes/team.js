// ============================================================
// TEAM ROUTE — real staff accounts (Team Access page)
// ------------------------------------------------------------
// Distinct from the three hardcoded demo logins in auth.js
// (admin/tech/viewer) and from customers (portal-only, miners-only
// access). A team member created here is a real login: username +
// hashed password, checked by auth.js on every sign-in, with a role
// the admin picks. Admin-only to manage — a team member shouldn't be
// able to create or remove other staff accounts, including their own.
// ============================================================
const express = require('express');
const router  = express.Router();
const { authMiddleware } = require('../middleware/auth');
const db = require('../services/db');
const { hashPassword, isHashed } = require('../services/passwords');

const VALID_ROLES = ['team', 'technician', 'viewer'];

function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin access required' });
  next();
}

// GET /api/team — list, password hash never leaves the server
router.get('/', authMiddleware, adminOnly, async (req, res) => {
  const members = await db.loadTeamMembers();
  const safe = members.map(m => {
    const { password, ...rest } = m;
    return { ...rest, has_password: !!password };
  });
  res.json({ ok: true, members: safe });
});

// POST /api/team — create a new team member
router.post('/', authMiddleware, adminOnly, async (req, res) => {
  const { name, username, password, role } = req.body || {};
  const cleanName = (name || '').trim();
  const cleanUser = (username || '').trim().toLowerCase();
  if (!cleanName)                 return res.status(400).json({ ok: false, error: 'Name is required' });
  if (!cleanUser)                 return res.status(400).json({ ok: false, error: 'Username is required' });
  if (!password || password.length < 6) return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters' });
  const cleanRole = VALID_ROLES.includes(role) ? role : 'team';

  // Reject a username that would collide with the hardcoded demo
  // accounts or an existing team member — logging in has no way to
  // tell two accounts with the same username apart.
  const RESERVED = ['admin', 'tech', 'viewer'];
  if (RESERVED.includes(cleanUser)) {
    return res.status(400).json({ ok: false, error: 'That username is reserved — pick another' });
  }
  const existing = await db.loadTeamMembers();
  if (existing.some(m => (m.username || '').toLowerCase() === cleanUser)) {
    return res.status(400).json({ ok: false, error: 'That username is already taken' });
  }

  const member = {
    id: 'team-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    name: cleanName,
    username: cleanUser,
    password: hashPassword(password),
    role: cleanRole,
    active: true,
    created_at: new Date().toISOString(),
  };
  const ok = await db.saveTeamMember(member);
  if (!ok) return res.status(500).json({ ok: false, error: 'Failed to save team member' });
  const { password: _p, ...safe } = member;
  res.json({ ok: true, member: { ...safe, has_password: true } });
});

// PUT /api/team/:id — edit name/username/role, optionally a new password
router.put('/:id', authMiddleware, adminOnly, async (req, res) => {
  const existing = await db.loadTeamMembers();
  const member = existing.find(m => m.id === req.params.id);
  if (!member) return res.status(404).json({ ok: false, error: 'Team member not found' });

  const { name, username, password, role, active } = req.body || {};
  if (name !== undefined) {
    const cleanName = String(name).trim();
    if (!cleanName) return res.status(400).json({ ok: false, error: 'Name is required' });
    member.name = cleanName;
  }
  if (username !== undefined) {
    const cleanUser = String(username).trim().toLowerCase();
    if (!cleanUser) return res.status(400).json({ ok: false, error: 'Username is required' });
    const RESERVED = ['admin', 'tech', 'viewer'];
    if (RESERVED.includes(cleanUser)) return res.status(400).json({ ok: false, error: 'That username is reserved — pick another' });
    if (existing.some(m => m.id !== member.id && (m.username || '').toLowerCase() === cleanUser)) {
      return res.status(400).json({ ok: false, error: 'That username is already taken' });
    }
    member.username = cleanUser;
  }
  if (role !== undefined && VALID_ROLES.includes(role)) member.role = role;
  if (active !== undefined) member.active = !!active;
  // Only touch the password if a real new one was actually typed —
  // an empty field here means "leave it as it is", same convention
  // as the customer edit form.
  if (password) {
    if (password.length < 6) return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters' });
    member.password = hashPassword(password);
  }

  const ok = await db.saveTeamMember(member);
  if (!ok) return res.status(500).json({ ok: false, error: 'Failed to save team member' });
  const { password: _p, ...safe } = member;
  res.json({ ok: true, member: { ...safe, has_password: true } });
});

// DELETE /api/team/:id
router.delete('/:id', authMiddleware, adminOnly, async (req, res) => {
  const ok = await db.deleteTeamMember(req.params.id);
  res.json({ ok });
});

module.exports = router;
