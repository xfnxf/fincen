const db = require('./db');
const { HANDLE_RE } = require('./fragment');

const enabled = process.env.CHECKOUT_SANDBOX === '1' && process.env.NODE_ENV !== 'production';
const statuses = {
  reserved: 'Reserved', paid: 'Test payment received', delivered: 'Transfer submitted',
  disputed: 'Disputed', paid_out: 'Test payout released', refunded: 'Test payment refunded',
  cancelled: 'Cancelled', expired: 'Reservation expired',
  dispute_reply: 'Dispute reply added',
};
const nextSteps = {
  reserved: ['buyer', 'Confirm test payment'],
  paid: ['seller', 'Submit the transfer reference'],
  delivered: ['reviewer', 'Review the transfer and release payout'],
  disputed: ['reviewer', 'Review the dispute and decide on a refund'],
};
const steps = {
  pay: { role: 'buyer', from: ['reserved'], to: 'paid', label: 'Simulate payment' },
  cancel: { role: 'buyer', from: ['reserved'], to: 'cancelled', label: 'Cancel reservation' },
  deliver: { role: 'seller', from: ['paid'], to: 'delivered', label: 'Submit test transfer', field: 'Test transfer reference' },
  dispute: { role: 'buyer', from: ['paid', 'delivered'], to: 'disputed', label: 'Open dispute', field: 'Dispute reason' },
  release: { role: 'reviewer', from: ['delivered'], to: 'paid_out', label: 'Verify transfer and simulate payout' },
  refund: { role: 'reviewer', from: ['paid', 'delivered', 'disputed'], to: 'refunded', label: 'Simulate refund' },
};

const orderById = db.prepare('SELECT * FROM sandbox_orders WHERE id = ?');
const currentOrder = db.prepare(`SELECT * FROM sandbox_orders WHERE thread_id = ?
  AND (status IN ('paid', 'delivered', 'disputed', 'paid_out') OR (status = 'reserved' AND expires_at > ?))`);
const expireReservations = db.prepare(`UPDATE sandbox_orders SET status = 'expired', updated_at = ?
  WHERE thread_id = ? AND status = 'reserved' AND expires_at <= ?`);
const approval = db.prepare('SELECT 1 FROM sandbox_checkout_listings WHERE thread_id = ? AND edited_at IS ?');
const loadListing = db.prepare(`SELECT t.*, f.slug AS forum_slug, u.banned AS seller_banned FROM threads t
  JOIN forums f ON f.id = t.forum_id JOIN users u ON u.id = t.user_id WHERE t.id = ?`);

function eligible(listing) {
  return !!listing && listing.forum_slug === 'telegram' && listing.listing_type === 'sell' &&
    listing.status === 'open' && !listing.deleted && Number.isSafeInteger(listing.price_cents) &&
    listing.price_cents > 0 && HANDLE_RE.test(listing.handle?.toLowerCase() || '');
}

function isApproved(listing) {
  return eligible(listing) && !!approval.get(listing.id, listing.edited_at);
}

function approve(listingId, staffId) {
  return transaction(() => {
    const listing = loadListing.get(listingId);
    if (!eligible(listing) || listing.seller_banned) return false;
    db.prepare(`INSERT INTO sandbox_checkout_listings (thread_id, edited_at, approved_by) VALUES (?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET edited_at = excluded.edited_at, approved_by = excluded.approved_by`)
      .run(listing.id, listing.edited_at, staffId);
    return true;
  });
}

function transaction(work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function reserve(listingId, buyerId) {
  return transaction(() => {
    const now = Date.now();
    expireReservations.run(now, listingId, now);
    const listing = loadListing.get(listingId);
    if (!isApproved(listing) || listing.seller_banned || listing.user_id === buyerId) return null;
    const existing = currentOrder.get(listingId, now);
    if (existing) return existing.buyer_id === buyerId ? existing.id : null;
    const result = db.prepare(`INSERT INTO sandbox_orders
      (thread_id, buyer_id, seller_id, handle, price_cents, created_at, expires_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(listingId, buyerId, listing.user_id, listing.handle, listing.price_cents, now, now + 10 * 60_000, now);
    return result.lastInsertRowid;
  });
}

function orderRole(order, user) {
  if (!user) return null;
  if (order.buyer_id === user.id) return 'buyer';
  if (order.seller_id === user.id) return 'seller';
  if (user.role === 'admin' || user.role === 'mod') return 'reviewer';
  return null;
}

function getOrder(id, user) {
  const order = orderById.get(id);
  if (!order || !orderRole(order, user)) return null;
  if (order.status === 'reserved' && order.expires_at <= Date.now()) order.status = 'expired';
  return order;
}

function actionsFor(order, user) {
  const role = orderRole(order, user);
  return Object.entries(steps).filter(([, step]) => step.role === role && step.from.includes(order.status));
}

function advance(id, user, action, detail) {
  return transaction(() => {
    const order = getOrder(id, user);
    if (!order) return 404;
    const step = Object.hasOwn(steps, action) ? steps[action] : null;
    if (!step || step.role !== orderRole(order, user)) return 403;
    if (!step.from.includes(order.status)) return 409;
    if (step.field && !detail) return 400;
    const now = Date.now();
    const result = db.prepare(`UPDATE sandbox_orders SET status = ?, updated_at = ?,
      delivery_ref = CASE WHEN ? = 'deliver' THEN ? ELSE delivery_ref END,
      dispute_note = CASE WHEN ? = 'dispute' THEN ? ELSE dispute_note END
      WHERE id = ? AND status = ? AND (status <> 'reserved' OR expires_at > ?)`)
      .run(step.to, now, action, detail, action, detail, id, order.status, now);
    if (!result.changes) return 409;
    if (order.status !== 'reserved' && !events.all(id).length) {
      insertEvent.run(id, order.status, order.updated_at);
    }
    recordEvent(order, step.to, now, user.id);
    return 200;
  });
}

const events = db.prepare('SELECT status, created_at FROM sandbox_order_events WHERE order_id = ? ORDER BY id');
const insertEvent = db.prepare('INSERT INTO sandbox_order_events (order_id, status, created_at) VALUES (?, ?, ?)');
const insertAlert = db.prepare('INSERT INTO sandbox_order_alerts (event_id, user_id) VALUES (?, ?)');
const reviewers = db.prepare("SELECT id FROM users WHERE role IN ('mod', 'admin') AND banned = 0 AND id NOT IN (?, ?)");
function recordEvent(order, status, now, actorId) {
  const id = insertEvent.run(order.id, status, now).lastInsertRowid;
  const recipients = new Set([order.buyer_id, order.seller_id]);
  if (['delivered', 'disputed', 'dispute_reply'].includes(status)) {
    for (const reviewer of reviewers.all(order.buyer_id, order.seller_id)) recipients.add(reviewer.id);
  }
  recipients.delete(actorId);
  for (const userId of recipients) insertAlert.run(id, userId);
}

function timeline(order) {
  const history = [{ status: 'reserved', created_at: order.created_at }, ...events.all(order.id)];
  if (order.status !== history.findLast((event) => event.status !== 'dispute_reply').status) {
    history.push({ status: order.status, created_at: order.status === 'expired' ? order.expires_at : order.updated_at });
  }
  return history;
}

function nextFor(order, user) {
  const step = nextSteps[order.status];
  if (!step) return 'No action needed';
  const [role, task] = step;
  if (orderRole(order, user) === role) return 'Your turn · ' + task;
  return 'Waiting for ' + (role === 'reviewer' ? 'staff review' : 'the ' + role);
}

const disputeReplies = db.prepare(`SELECT r.*, u.username FROM sandbox_dispute_replies r JOIN users u ON u.id = r.author_id
  WHERE r.order_id = ? ORDER BY r.id`);
function replyToDispute(id, user, body) {
  return transaction(() => {
    const order = getOrder(id, user);
    if (!order) return 404;
    if (order.status !== 'disputed') return 409;
    const now = Date.now();
    if (!events.all(id).length) insertEvent.run(id, order.status, order.updated_at);
    db.prepare('INSERT INTO sandbox_dispute_replies (order_id, author_id, body, created_at) VALUES (?, ?, ?, ?)')
      .run(id, user.id, body, now);
    recordEvent(order, 'dispute_reply', now, user.id);
    return 200;
  });
}

const unreadAlerts = db.prepare('SELECT COUNT(*) AS c FROM sandbox_order_alerts WHERE user_id = ? AND read = 0');
function readAlerts(userId) {
  return transaction(() => {
    const items = db.prepare(`SELECT a.read, e.created_at, e.status, o.handle, o.id AS order_id
      FROM sandbox_order_alerts a JOIN sandbox_order_events e ON e.id = a.event_id
      JOIN sandbox_orders o ON o.id = e.order_id WHERE a.user_id = ? ORDER BY e.id DESC LIMIT 60`).all(userId);
    db.prepare('UPDATE sandbox_order_alerts SET read = 1 WHERE user_id = ? AND read = 0').run(userId);
    return items.map((item) => ({ ...item, kind: 'sandbox_order', label: statuses[item.status] }));
  });
}

function activeFor(threadId) {
  return currentOrder.get(threadId, Date.now());
}

function lockListing(threadId) {
  const current = enabled && activeFor(threadId);
  return current && current.status !== 'paid_out';
}

module.exports = { enabled, statuses, eligible, isApproved, approve, reserve, getOrder, actionsFor, advance, activeFor, lockListing,
  timeline, nextFor, disputeReplies, replyToDispute, unreadAlerts, readAlerts, transaction };
