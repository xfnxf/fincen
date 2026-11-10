const db = require('./db');

// listings: how many listings a member may have open at once (0 = cannot post listings, null = no limit).
// bumpHours: how often one listing can be bumped. featured: listings are highlighted in lists.
const plans = {
  free: { name: 'Free', level: 0, price: 0, listings: 0, bumpHours: 24, featured: false,
    perks: ['Read and reply in every forum', 'Message members and save listings', 'Ask for price checks and middlemen'] },
  plus: { name: 'Argent', level: 1, price: 500, listings: 5, bumpHours: 24, featured: false,
    perks: ['Post listings, up to 5 open at once', 'Bump each listing every 24 hours', 'Argent profile badge and custom headline',
      'Saved searches', 'Price-drop alerts for saved listings'] },
  pro: { name: 'Aurum', level: 2, price: 1200, listings: 25, bumpHours: 12, featured: false,
    perks: ['Everything in Argent', 'Up to 25 open listings', 'Bump every 12 hours', 'Aurum profile badge',
      'Seller dashboard and bulk listing controls', 'Export your listings as CSV'] },
  elite: { name: 'Imperium', level: 3, price: 2500, listings: null, bumpHours: 6, featured: true,
    perks: ['Everything in Aurum', 'Unlimited open listings', 'Bump every 6 hours', 'Listings highlighted in gold across the market',
      'Imperium badge and gold profile accent'] },
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

// The full plan record (limits and all) for a member.
const planFor = (userId) => plans[current(userId).plan];

module.exports = { plans, current, planFor, hasTier, choose, setHeadline };
