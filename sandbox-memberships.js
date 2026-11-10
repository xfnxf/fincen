const db = require('./db');

const plans = {
  free: { name: 'Free', level: 0, price: 0, perks: ['Post listings and join forum discussions', 'Save listings and message members'] },
  plus: { name: 'Plus', level: 1, price: 500, perks: ['Plus profile badge and custom headline', 'Saved searches', 'Price-drop alerts for saved listings'] },
  pro: { name: 'Pro', level: 2, price: 1200, perks: ['Everything in Plus', 'Pro profile badge', 'Seller dashboard and bulk listing controls',
    'Export your listings as CSV'] },
  elite: { name: 'Elite', level: 3, price: 2500, perks: ['Everything in Pro', 'Elite badge and gold profile accent'] },
};
const get = db.prepare('SELECT plan, headline FROM sandbox_memberships WHERE user_id = ?');
const reset = db.prepare("UPDATE sandbox_memberships SET plan = 'free' WHERE user_id = ?");

function current(userId) {
  const row = get.get(userId);
  if (row && row.plan !== 'free') return row;
  return { plan: 'free', headline: '' };
}

function hasTier(userId, tier) {
  return plans[current(userId).plan].level >= plans[tier].level;
}

function choose(userId, plan) {
  if (!Object.hasOwn(plans, plan)) return false;
  if (plan === 'free') return !!reset.run(userId).changes;
  const lower = Object.keys(plans).filter((key) => plans[key].level < plans[plan].level);
  return !!db.prepare(`INSERT INTO sandbox_memberships (user_id, plan) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET plan = excluded.plan
    WHERE sandbox_memberships.plan IN (${lower.map(() => '?').join(', ')})`).run(userId, plan, ...lower).changes;
}

function setHeadline(userId, headline) {
  return db.prepare(`UPDATE sandbox_memberships SET headline = ?
    WHERE user_id = ? AND plan <> 'free'`).run(headline, userId).changes;
}

module.exports = { plans, current, hasTier, choose, setHeadline };
