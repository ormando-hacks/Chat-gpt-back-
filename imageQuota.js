const db = require('./database');

// Hugging Face's free tier only covers a small credit balance, so
// self-serve accounts (generated via /api/account/generate-id) are
// capped to protect it from being burned through by a handful of users.
const DAILY_LIMIT = 2;

function isExempt(user) {
  // The master-admin-linked "owner" account is trusted and unmetered.
  return !!user && (user.role === 'owner' || (Array.isArray(user.permissions) && user.permissions.includes('all')));
}

function todayKey() {
  return new Date().toISOString().slice(0, 10); // UTC calendar day
}

/**
 * Checks and, if allowed, consumes one unit of a user's daily image
 * generation quota. Call this BEFORE invoking the paid image provider —
 * the slot is consumed on the attempt, not only on success, since the
 * provider call itself is what costs money.
 */
function checkAndConsume(userId) {
  const user = db.users.get(userId);
  if (!user) return { allowed: false, error: 'Unknown account' };
  if (isExempt(user)) return { allowed: true, unlimited: true };

  const today = todayKey();
  if (user.imageQuotaDate !== today) {
    user.imageQuotaDate = today;
    user.imageQuotaUsed = 0;
  }
  user.imageQuotaUsed = user.imageQuotaUsed || 0;

  if (user.imageQuotaUsed >= DAILY_LIMIT) {
    return {
      allowed: false,
      limit: DAILY_LIMIT,
      used: user.imageQuotaUsed,
      error: `Daily image generation limit reached (${DAILY_LIMIT}/day per account). Resets at 00:00 UTC.`
    };
  }

  user.imageQuotaUsed += 1;
  db.users.set(userId, user);
  db.persistSoon();
  return { allowed: true, limit: DAILY_LIMIT, used: user.imageQuotaUsed };
}

module.exports = { checkAndConsume, DAILY_LIMIT };
