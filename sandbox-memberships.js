const db = require('./db');

const plans = {
  free: { name: 'Free', price: 0, perks: ['Current marketplace and forum features'] },
  plus: { name: 'Plus', price: 500, perks: ['Plus profile badge and custom headline', 'Saved searches', 'Price-drop alerts for saved listings'] },
  pro: { name: 'Pro', price: 1200, perks: ['Pro profile badge and custom headline', 'Saved searches and price-drop alerts',
    'Seller dashboard and bulk listing controls', 'Export your listings as CSV'] },
};
const get = db.prepare('SELECT plan, expires_at, headline FROM sandbox_memberships WHERE user_id = ?');
const put = db.prepare(`INSERT INTO sandbox_memberships (user_id, plan, expires_at) VALUES (?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET plan = excluded.plan, expires_at = excluded.expires_at
  WHERE sandbox_memberships.plan <> excluded.plan OR sandbox_memberships.expires_at <= ?`);

function current(userId) {
  const row = get.get(userId);
  if (row && row.plan !== 'free' && row.expires_at > Date.now()) return row;
  return { plan: 'free', expires_at: 0, headline: '' };
}

function choose(userId, plan) {
  if (!Object.hasOwn(plans, plan)) return false;
  const now = Date.now();
  put.run(userId, plan, plan === 'free' ? 0 : now + 30 * 86400_000, now);
  return true;
}

function setHeadline(userId, headline) {
  return db.prepare(`UPDATE sandbox_memberships SET headline = ?
    WHERE user_id = ? AND plan <> 'free' AND expires_at > ?`).run(headline, userId, Date.now()).changes;
}

module.exports = { plans, current, choose, setHeadline };
