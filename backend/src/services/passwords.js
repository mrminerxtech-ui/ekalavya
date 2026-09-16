// ============================================================
// PASSWORD HASHING — for real customer portal accounts
// Uses Node's built-in crypto module (scrypt) — no extra
// dependency needed. Format: "scrypt:<salt>:<hash>"
// ============================================================
const crypto = require('crypto');

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(plain, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(plain, stored) {
  if (!plain || !stored || !isHashed(stored)) return false;
  const [, salt, hash] = stored.split(':');
  try {
    const check = crypto.scryptSync(plain, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
  } catch(e) { return false; }
}

function isHashed(value) {
  return typeof value === 'string' && value.startsWith('scrypt:');
}

module.exports = { hashPassword, verifyPassword, isHashed };
