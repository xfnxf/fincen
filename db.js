// SQLite database (Node's built-in driver): schema + default forums.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'forum.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const membershipSchema = `CREATE TABLE IF NOT EXISTS sandbox_memberships (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL CHECK (plan IN ('free', 'plus', 'pro', 'elite')),
  headline TEXT NOT NULL DEFAULT ''
);`;

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',          -- member | mod | admin
  banned INTEGER NOT NULL DEFAULT 0,
  ban_reason TEXT,
  bio TEXT NOT NULL DEFAULT '',
  contact TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS user_avatars (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  image BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS forums (
  id INTEGER PRIMARY KEY,
  section TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_market INTEGER NOT NULL DEFAULT 0,
  staff_only INTEGER NOT NULL DEFAULT 0,        -- only staff can start threads
  position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS threads (
  id INTEGER PRIMARY KEY,
  forum_id INTEGER NOT NULL REFERENCES forums(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_post_at INTEGER NOT NULL,
  last_post_user_id INTEGER REFERENCES users(id),
  reply_count INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  locked INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  listing_type TEXT,                            -- sell | buy (market forums only)
  handle TEXT,                                  -- the username being listed
  price_cents INTEGER,                          -- NULL = open to offers
  status TEXT NOT NULL DEFAULT 'open'           -- open | sold | closed
);
CREATE INDEX IF NOT EXISTS idx_threads_forum ON threads(forum_id, deleted, pinned, last_post_at);
CREATE INDEX IF NOT EXISTS idx_threads_user ON threads(user_id);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES threads(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_posts_thread ON posts(thread_id, deleted, id);
CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id);
CREATE TABLE IF NOT EXISTS vouches (
  id INTEGER PRIMARY KEY,
  from_id INTEGER NOT NULL REFERENCES users(id),
  to_id INTEGER NOT NULL REFERENCES users(id),
  rating INTEGER NOT NULL,                      -- signed reputation points
  comment TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(from_id, to_id)
);
CREATE INDEX IF NOT EXISTS idx_vouches_to ON vouches(to_id);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  from_id INTEGER NOT NULL REFERENCES users(id),
  to_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_id, read);
CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_id);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY,
  reporter_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,                           -- thread | post | user
  target_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',          -- open | resolved
  handled_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS saves (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id INTEGER NOT NULL REFERENCES threads(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, thread_id)
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                           -- reply | vouch | status | broker_reply
  actor_id INTEGER REFERENCES users(id),
  thread_id INTEGER,
  post_id INTEGER,
  created_at INTEGER NOT NULL,
  read INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read);
`);

// Columns added after the first version (safe to run on an existing database).
function addColumn(table, column, definition) {
  const have = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!have.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumn('users', 'email', 'TEXT');               // optional, only used for password resets
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users (email COLLATE NOCASE) WHERE email IS NOT NULL');
db.exec(`CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,                   -- sha256 of the token; the token itself is only in the email
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
)`);
addColumn('users', 'prev_visit', 'INTEGER');     // start of the previous visit, for "new" markers
addColumn('users', 'retired_at', 'INTEGER');
addColumn('threads', 'bumped_at', 'INTEGER');
addColumn('threads', 'edited_at', 'INTEGER');
addColumn('threads', 'status_at', 'INTEGER');
addColumn('posts', 'edited_at', 'INTEGER');
addColumn('vouches', 'deal_thread_id', 'INTEGER REFERENCES threads(id) ON DELETE SET NULL');

// Default forum layout. Edit here (or in the DB) to add platforms.
const DEFAULT_FORUMS = [
  ['News', 'announcements', 'Announcements', 'News and updates from staff.', 0, 1],
  ['Marketplace', 'discord', 'Discord', 'Buy and sell Discord usernames.', 1, 0],
  ['Marketplace', 'telegram', 'Telegram', 'Telegram usernames, channels and collectible handles.', 1, 0],
  ['Marketplace', 'instagram', 'Instagram', 'Instagram handles.', 1, 0],
  ['Marketplace', 'x', 'X / Twitter', 'X (Twitter) handles.', 1, 0],
  ['Marketplace', 'roblox', 'Roblox', 'Roblox usernames.', 1, 0],
  ['Marketplace', 'minecraft', 'Minecraft', 'Minecraft Java & Bedrock names.', 1, 0],
  ['Misc', 'fortnite', 'Fortnite', 'Epic Games display names and Fortnite accounts.', 1, 0],
  ['Misc', 'psn', 'PSN', 'PlayStation Network online IDs.', 1, 0],
  ['Misc', 'xbox', 'Xbox', 'Xbox gamertags.', 1, 0],
  ['Misc', 'snapchat', 'Snapchat', 'Snapchat usernames.', 1, 0],
  ['Misc', 'twitch', 'Twitch', 'Twitch usernames.', 1, 0],
  ['Misc', 'steam', 'Steam', 'Steam custom URLs and accounts.', 1, 0],
  ['Community', 'general', 'General Discussion', 'Talk about anything.', 0, 0],
  ['Community', 'middleman', 'Middleman Requests', 'Ask a trusted staff member to hold a deal.', 0, 0],
  ['Community', 'price-checks', 'Price Checks', 'Not sure what a name is worth? Ask here.', 0, 0],
  ['Community', 'scam-reports', 'Scam Reports', 'Report a deal gone wrong, with proof.', 0, 0],
];

// Adds any default forum that is missing and keeps the defaults in the order above.
// Forums added by hand in the DB are left alone.
{
  const has = db.prepare('SELECT 1 FROM forums WHERE slug = ?');
  const ins = db.prepare(
    'INSERT INTO forums (section, slug, name, description, is_market, staff_only, position) VALUES (?,?,?,?,?,?,?)'
  );
  const move = db.prepare('UPDATE forums SET position = ?, section = ? WHERE slug = ?');
  DEFAULT_FORUMS.forEach((f, i) => {
    if (has.get(f[1])) move.run(i, f[0], f[1]);
    else ins.run(...f, i);
  });
}

// Trading was removed as a listing type; old trade listings become sell listings.
db.prepare("UPDATE threads SET listing_type = 'sell' WHERE listing_type = 'trade'").run();

// Names for sale on other marketplaces, imported for reference (see import_fragment.js).
db.exec(`CREATE TABLE IF NOT EXISTS external_listings (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  handle TEXT NOT NULL,
  price_ton REAL NOT NULL,
  url TEXT NOT NULL,
  ends_at INTEGER,
  fetched_at INTEGER NOT NULL,
  UNIQUE (source, handle)
)`);
addColumn('external_listings', 'price_kind', "TEXT NOT NULL DEFAULT 'sale'");

// Requests asking staff to broker a name that is listed elsewhere.
db.exec(`CREATE TABLE IF NOT EXISTS broker_requests (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  source TEXT NOT NULL,
  handle TEXT NOT NULL,
  price_ton REAL,
  budget TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  handled_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL
)`);

db.exec(`CREATE TABLE IF NOT EXISTS broker_replies (
  id INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES broker_requests(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_broker_replies_request ON broker_replies(request_id, id);`);
addColumn('notifications', 'broker_request_id', 'INTEGER REFERENCES broker_requests(id) ON DELETE CASCADE');

db.exec(`
CREATE TABLE IF NOT EXISTS sandbox_checkout_listings (
  thread_id INTEGER PRIMARY KEY REFERENCES threads(id),
  edited_at INTEGER,
  approved_by INTEGER NOT NULL REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS sandbox_orders (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES threads(id),
  buyer_id INTEGER NOT NULL REFERENCES users(id),
  seller_id INTEGER NOT NULL REFERENCES users(id),
  handle TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN (
    'reserved', 'paid', 'delivered', 'disputed', 'paid_out', 'refunded', 'cancelled', 'expired'
  )),
  delivery_ref TEXT,
  dispute_note TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sandbox_orders_single_sale ON sandbox_orders(thread_id)
  WHERE status IN ('reserved', 'paid', 'delivered', 'disputed', 'paid_out');
${membershipSchema}
CREATE TABLE IF NOT EXISTS membership_orders (
  id INTEGER PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,                    -- reference sent to the payment provider
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL CHECK (plan IN ('plus', 'pro', 'elite')),
  price_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',        -- pending | paid | partial | failed | expired | refunded
  invoice_id TEXT,
  invoice_url TEXT,
  payment_id TEXT,
  pay_currency TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_membership_orders_user ON membership_orders(user_id, id);
CREATE TABLE IF NOT EXISTS sandbox_order_events (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES sandbox_orders(id),
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sandbox_events_order ON sandbox_order_events(order_id, id);
CREATE TABLE IF NOT EXISTS sandbox_order_alerts (
  event_id INTEGER NOT NULL REFERENCES sandbox_order_events(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  read INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_sandbox_alerts_user ON sandbox_order_alerts(user_id, read);
CREATE TABLE IF NOT EXISTS sandbox_dispute_replies (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES sandbox_orders(id),
  author_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sandbox_replies_order ON sandbox_dispute_replies(order_id, id);
CREATE TABLE IF NOT EXISTS sandbox_saved_searches (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  query TEXT NOT NULL,
  name TEXT NOT NULL,
  UNIQUE(user_id, query)
);
`);

// Carry over test purchases and headlines from the old 30-day memberships.
db.exec('BEGIN IMMEDIATE');
try {
  if (db.prepare('PRAGMA table_info(sandbox_memberships)').all().some((column) => column.name === 'expires_at')) {
    db.exec(`
      ALTER TABLE sandbox_memberships RENAME TO sandbox_memberships_legacy;
      ${membershipSchema}
      INSERT INTO sandbox_memberships (user_id, plan, headline)
        SELECT user_id, plan, headline FROM sandbox_memberships_legacy;
      DROP TABLE sandbox_memberships_legacy;
    `);
  }
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}

module.exports = db;
