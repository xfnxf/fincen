const express = require('express');
const path = require('path');
const db = require('./db');
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');
const { hashPassword, verifyPassword, token, safeEqual } = require('./auth');
const mail = require('./mail');
const fragment = require('./fragment');
const sandbox = require('./sandbox-checkout');
const memberships = require('./sandbox-memberships');

const SITE = process.env.SITE_NAME || 'Fincen';
const PORT = Number(process.env.PORT) || 3000;
const PROD = process.env.NODE_ENV === 'production';
// Public address of the site, used in emailed links. No trailing slash.
const SITE_URL = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const RESET_MS = 3600 * 1000;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const PER_PAGE = 20;
const SESSION_MS = 30 * 24 * 3600 * 1000;
const DAY = 24 * 3600 * 1000;
const ONLINE_MS = 10 * 60 * 1000;
const USER_RE = /^[A-Za-z0-9_.]{3,20}$/;
const LISTING_TYPES = { sell: 'Selling', buy: 'Buying' };
const LISTING_SHORT = { sell: 'WTS', buy: 'WTB' };
const STATUSES = { open: 'Open', sold: 'Sold', closed: 'Closed' };
const avatarUpload = multer({
  limits: { fileSize: 4 * 1024 * 1024, files: 1, fields: 1, fieldSize: 128 },
}).single('avatar');
sharp.block({ operation: ['VipsForeignLoad'] });
sharp.unblock({
  operation: ['VipsForeignLoadJpegBuffer', 'VipsForeignLoadPngBuffer', 'VipsForeignLoadWebpBuffer'],
});

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', 1); // set when behind nginx/Cloudflare
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

/* ---------- template helpers ---------- */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ago = (ts) => {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' hr ago';
  if (s < 30 * 86400) { const d = Math.floor(s / 86400); return d + (d === 1 ? ' day ago' : ' days ago'); }
  return new Date(ts).toISOString().slice(0, 10);
};
// Escapes the text, turns links into anchors and "> quoted" lines into quote blocks.
const inline = (s) =>
  esc(s).replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]]/g, (u) => `<a href="${u}" rel="nofollow noopener noreferrer" target="_blank">${u}</a>`);
function fmt(text) {
  const parts = [];
  for (const line of String(text).split('\n')) {
    const quoted = line.startsWith('>');
    const last = parts[parts.length - 1];
    const value = quoted ? line.replace(/^>\s?/, '') : line;
    if (last && last.quoted === quoted) last.lines.push(value);
    else parts.push({ quoted, lines: [value] });
  }
  return parts
    .map((p) => (p.quoted ? `<blockquote>${inline(p.lines.join('\n'))}</blockquote>` : inline(p.lines.join('\n'))))
    .join('');
}

Object.assign(app.locals, {
  site: SITE, LISTING_TYPES, LISTING_SHORT, STATUSES, ago, fmt, checkoutEnabled: sandbox.enabled,
  time: (ts) => `<time datetime="${new Date(ts).toISOString()}" title="${new Date(ts).toUTCString()}">${ago(ts)}</time>`,
  date: (ts) => new Date(ts).toISOString().slice(0, 10),
  money: (cents) =>
    cents == null
      ? 'Offers'
      : '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 }),
  signed: (n) => (n > 0 ? '+' + n : String(n)),
  online: (ts) => Date.now() - ts < ONLINE_MS,
  rank: (rep, joined) =>
    rep >= 10 ? 'Trusted trader' : rep >= 1 ? 'Trader' : Date.now() - joined < 7 * DAY ? 'New member' : 'Member',
});

/* ---------- small utilities ---------- */
const clean = (v, max) => String(v ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
const isMod = (u) => !!u && (u.role === 'mod' || u.role === 'admin');
const likeEscape = (s) => s.replace(/[\\%_]/g, '\\$&');

function setCookie(res, name, value, maxAgeMs, httpOnly = true) {
  res.append(
    'Set-Cookie',
    `${name}=${value}; Path=/; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}` +
      (httpOnly ? '; HttpOnly' : '') + (PROD ? '; Secure' : '')
  );
}
function flash(res, msg) {
  setCookie(res, 'flash', encodeURIComponent(msg), 60000);
}
function fail(res, status, message) {
  return res.status(status).render('error', { title: 'Error', status, message });
}
function back(req, fallback) {
  const next = String(req.body?.next || req.query?.next || '');
  return next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') ? next : fallback;
}
function paging(req, total, perPage = PER_PAGE) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(pages, Math.max(1, parseInt(req.query.page, 10) || 1));
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query)) if (k !== 'page' && typeof v === 'string' && v) params.set(k, v);
  return {
    page, pages, total, perPage, offset: (page - 1) * perPage,
    url: (n) => {
      const p = new URLSearchParams(params);
      if (n > 1) p.set('page', n);
      const s = p.toString();
      return req.path + (s ? '?' + s : '');
    },
  };
}

// In-memory rate limiter (per user, or per IP when logged out).
const hits = new Map();
function limit(name, max, windowMs) {
  return (req, res, next) => {
    const key = name + ':' + (req.user ? 'u' + req.user.id : req.ip);
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) return fail(res, 429, 'Too many requests. Wait a bit and try again.');
    recent.push(now);
    hits.set(key, recent);
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of hits) if (!arr.length || now - arr[arr.length - 1] > 3600e3) hits.delete(k);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
}, 600e3).unref();

/* ---------- shared SQL ---------- */
const USER_STATS = `
  (SELECT COALESCE(SUM(v.rating),0) FROM vouches v JOIN users reviewer ON reviewer.id = v.from_id
    WHERE v.to_id = u.id AND reviewer.retired_at IS NULL) AS rep,
  (SELECT COUNT(*) FROM vouches v JOIN users reviewer ON reviewer.id = v.from_id
    WHERE v.to_id = u.id AND reviewer.retired_at IS NULL) AS fb_count,
  (SELECT COUNT(*) FROM posts p2 JOIN threads pt ON pt.id = p2.thread_id
    WHERE p2.user_id = u.id AND p2.deleted = 0 AND pt.deleted = 0)
    + (SELECT COUNT(*) FROM threads t2 WHERE t2.user_id = u.id AND t2.deleted = 0) AS post_count`;
const THREAD_SELECT = `
  SELECT t.*, u.username AS author, u.role AS author_role, lu.username AS last_user,
         f.slug AS forum_slug, f.name AS forum_name, f.is_market
  FROM threads t
  JOIN users u ON u.id = t.user_id
  JOIN forums f ON f.id = t.forum_id
  LEFT JOIN users lu ON lu.id = t.last_post_user_id`;

const q = {
  userByName: db.prepare('SELECT * FROM users WHERE username = ? AND retired_at IS NULL'),
  forumBySlug: db.prepare('SELECT * FROM forums WHERE slug = ?'),
  thread: db.prepare(`${THREAD_SELECT} WHERE t.id = ? AND t.deleted = 0`),
  fbCounts: db.prepare(`SELECT
    COALESCE(SUM(rating > 0),0) AS pos, COALESCE(SUM(rating = 0),0) AS neu, COALESCE(SUM(rating < 0),0) AS neg
    FROM vouches v JOIN users reviewer ON reviewer.id = v.from_id WHERE v.to_id = ? AND reviewer.retired_at IS NULL`),
};
const ALL_FORUMS = db.prepare('SELECT slug, name, section, is_market FROM forums ORDER BY position').all();
const PLATFORMS = ALL_FORUMS.filter((f) => f.is_market);

function notify(userId, kind, actorId, threadId = null, postId = null, brokerRequestId = null) {
  if (userId === actorId) return;
  db.prepare(`INSERT INTO notifications (user_id, kind, actor_id, thread_id, post_id, broker_request_id, created_at)
    VALUES (?,?,?,?,?,?,?)`).run(userId, kind, actorId, threadId, postId, brokerRequestId, Date.now());
}

/* ---------- middleware ---------- */
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
  });
  // defaults so the error page can render even if a later middleware fails
  Object.assign(res.locals, {
    me: null, isMod: false, csrf: '', flash: null, path: '/', unread: 0, alerts: 0, openReports: 0,
    theme: 'dark', since: Infinity, platforms: PLATFORMS, allForums: ALL_FORUMS, navSlug: null, searchQ: '',
  });
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { maxAge: PROD ? '1h' : 0 }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));

app.use((req, res, next) => {
  // cookies
  const cookies = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) cookies[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  req.cookies = cookies;

  // session
  req.user = null;
  if (/^[a-f0-9]{64}$/.test(cookies.sid || '')) {
    const now = Date.now();
    const user = db
      .prepare(`SELECT u.*, EXISTS (SELECT 1 FROM user_avatars WHERE user_id = u.id) AS has_avatar
        FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?`)
      .get(cookies.sid, now);
    if (user && !user.banned) {
      req.user = user;
      if (now - user.last_seen > 60000) {
        // A gap of 30+ minutes starts a new visit; threads active since the old one get a "new" marker.
        if (now - user.last_seen > 30 * 60000) {
          user.prev_visit = user.last_seen;
          db.prepare('UPDATE users SET prev_visit = ? WHERE id = ?').run(user.prev_visit, user.id);
        }
        db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(now, user.id);
        user.last_seen = now;
      }
    }
  }

  // CSRF token for forms. POST requests are checked once their body is parsed.
  let csrf = cookies.csrf;
  if (!/^[a-f0-9]{64}$/.test(csrf || '')) {
    csrf = token();
    setCookie(res, 'csrf', csrf, SESSION_MS);
  }
  // flash message
  let flashMsg = null;
  if (cookies.flash) {
    try { flashMsg = decodeURIComponent(cookies.flash).slice(0, 300); } catch { /* ignore */ }
    setCookie(res, 'flash', '', 0);
  }

  const me = req.user;
  Object.assign(res.locals, {
    me, isMod: isMod(me), csrf, flash: flashMsg, path: req.originalUrl,
    theme: cookies.theme === 'light' ? 'light' : 'dark',
    since: me ? me.prev_visit ?? me.created_at : Infinity,
    unread: me ? db.prepare('SELECT COUNT(*) AS c FROM messages WHERE to_id = ? AND read = 0').get(me.id).c : 0,
    alerts: me ? db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read = 0').get(me.id).c
      + (sandbox.enabled ? sandbox.unreadAlerts.get(me.id).c : 0) : 0,
    openReports: isMod(me) ? db.prepare("SELECT (SELECT COUNT(*) FROM reports WHERE status = 'open') + (SELECT COUNT(*) FROM broker_requests WHERE status = 'open') AS c").get().c : 0,
  });
  next();
});

function requireLogin(req, res, next) {
  if (req.user) return next();
  if (req.method === 'GET') return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  return fail(res, 401, 'You need to log in to do that.');
}

function checkCsrf(req, res, next) {
  if (req.method === 'POST' && !safeEqual(req.body?._csrf, req.cookies.csrf)) {
    return fail(res, 403, 'Your form expired. Go back, refresh the page and try again.');
  }
  next();
}

function renderSettingsError(res, status, error) {
  return res.status(status).render('settings', { title: 'Settings', error });
}

// Authenticate and rate-limit before buffering an image. Check CSRF after reading the form.
app.post('/settings/avatar', requireLogin, limit('avatar', 10, 600000), (req, res, next) => {
  avatarUpload(req, res, (error) => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') return renderSettingsError(res, 413, 'Choose a picture under 4 MB.');
    return renderSettingsError(res, 400, 'Choose one JPEG, PNG, or WebP picture.');
  });
}, checkCsrf, async (req, res) => {
  if (!req.file) return renderSettingsError(res, 400, 'Choose a picture to upload.');
  let image;
  try {
    image = await sharp(req.file.buffer, { limitInputPixels: 16_000_000, failOn: 'warning' })
      .autoOrient()
      .resize(256, 256, { fit: 'cover' })
      .webp()
      .toBuffer();
  } catch {
    return renderSettingsError(res, 400, 'Choose a valid JPEG, PNG, or WebP picture up to 16 megapixels.');
  }
  db.prepare(`INSERT INTO user_avatars (user_id, image) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET image = excluded.image`).run(req.user.id, image);
  flash(res, 'Profile picture saved.');
  res.redirect('/settings');
});
app.use(checkCsrf);

function requireMod(req, res, next) {
  if (isMod(req.user)) return next();
  return fail(res, 403, 'Staff only.');
}

function startSession(res, userId) {
  const sid = token();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)').run(sid, userId, Date.now() + SESSION_MS);
  setCookie(res, 'sid', sid, SESSION_MS);
}

/* ---------- home ---------- */
app.get('/', (req, res) => {
  const forums = db.prepare(`
    SELECT f.*,
      (SELECT COUNT(*) FROM threads t WHERE t.forum_id = f.id AND t.deleted = 0) AS thread_count,
      (SELECT COALESCE(SUM(t.reply_count),0) FROM threads t WHERE t.forum_id = f.id AND t.deleted = 0) AS reply_count
    FROM forums f ORDER BY f.position`).all();
  const latest = db.prepare(`
    SELECT t.id, t.title, t.handle, t.last_post_at, COALESCE(lu.username, u.username) AS last_user
    FROM threads t JOIN users u ON u.id = t.user_id LEFT JOIN users lu ON lu.id = t.last_post_user_id
    WHERE t.forum_id = ? AND t.deleted = 0 ORDER BY t.last_post_at DESC LIMIT 1`);
  const sections = [];
  for (const f of forums) {
    f.latest = latest.get(f.id);
    let s = sections.find((x) => x.name === f.section);
    if (!s) sections.push((s = { name: f.section, forums: [] }));
    s.forums.push(f);
  }
  const recent = db.prepare(`${THREAD_SELECT}
    WHERE t.deleted = 0 AND f.is_market = 1 AND t.status = 'open' ORDER BY t.created_at DESC LIMIT 8`).all();
  const sold = db.prepare(`${THREAD_SELECT}
    WHERE t.deleted = 0 AND f.is_market = 1 AND t.status = 'sold'
    ORDER BY COALESCE(t.status_at, t.created_at) DESC LIMIT 5`).all();
  const top = db.prepare(`SELECT u.username, ${USER_STATS} FROM users u WHERE u.banned = 0 AND rep > 0 ORDER BY rep DESC, u.id LIMIT 5`).all();
  const onlineUsers = db.prepare('SELECT username, role FROM users WHERE last_seen > ? AND banned = 0 ORDER BY last_seen DESC LIMIT 40')
    .all(Date.now() - ONLINE_MS);
  const stats = db.prepare(`SELECT
    (SELECT COUNT(*) FROM users WHERE retired_at IS NULL) AS users,
    (SELECT COUNT(*) FROM threads WHERE deleted = 0) AS threads,
    (SELECT COUNT(*) FROM posts p JOIN threads t ON t.id = p.thread_id WHERE p.deleted = 0 AND t.deleted = 0) AS posts,
    (SELECT COUNT(*) FROM threads t JOIN forums f ON f.id = t.forum_id
       WHERE t.deleted = 0 AND f.is_market = 1 AND t.status = 'open') AS listings`).get();
  const newest = db.prepare('SELECT username FROM users WHERE retired_at IS NULL ORDER BY id DESC LIMIT 1').get();
  res.render('index', { title: null, sections, recent, sold, top, onlineUsers, stats, newest });
});

app.get('/rules', (req, res) => res.render('rules', { title: 'Rules' }));
app.get('/help', (req, res) => res.render('help', { title: 'Help' }));
app.get('/go', (req, res) => res.redirect(q.forumBySlug.get(String(req.query.f || '')) ? '/f/' + req.query.f : '/'));
app.get('/sell', requireLogin, (req, res) => res.render('sell', { title: 'Post a listing' }));

app.get('/staff', (req, res) => {
  const staff = db.prepare(`SELECT u.username, u.role, u.last_seen, u.created_at, u.contact, ${USER_STATS}
    FROM users u WHERE u.role IN ('admin','mod') AND u.banned = 0 ORDER BY u.role = 'admin' DESC, u.username`).all();
  res.render('staff', { title: 'Staff', staff });
});

/* ---------- auth ---------- */
app.get('/healthz', (req, res) => res.type('text').send('ok'));

app.get('/register', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('auth', { title: 'Register', mode: 'register', error: null, username: '', email: '', next: back(req, '/') });
});

app.post('/register', limit('register', 5, 3600e3), async (req, res) => {
  const username = clean(req.body.username, 32);
  const password = String(req.body.password || '');
  const email = clean(req.body.email, 254).toLowerCase();
  let error = null;
  if (!USER_RE.test(username)) error = 'Username must be 3–20 characters: letters, numbers, _ or .';
  else if (password.length < 8 || password.length > 200) error = 'Password must be at least 8 characters.';
  else if (password !== String(req.body.password2 || '')) error = 'Passwords do not match.';
  else if (!req.body.agree) error = 'You must agree to the rules to register.';
  else if (q.userByName.get(username)) error = 'That username is taken.';
  else if (email && !EMAIL_RE.test(email)) error = 'That email address does not look right.';
  else if (email && db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE').get(email)) error = 'That email is already used by another account.';
  if (error) return res.status(400).render('auth', { title: 'Register', mode: 'register', error, username, email, next: back(req, '/') });

  const hash = await hashPassword(password);
  const now = Date.now();
  let info;
  try {
    info = db.prepare('INSERT INTO users (username, pass_hash, email, created_at, last_seen) VALUES (?,?,?,?,?)')
      .run(username, hash, email || null, now, now);
  } catch {
    return res.status(400).render('auth', { title: 'Register', mode: 'register', error: 'That username or email is taken.', username, email, next: back(req, '/') });
  }
  startSession(res, info.lastInsertRowid);
  flash(res, `Welcome, ${username}. See the Help page for the buying and selling guide.`);
  res.redirect(back(req, '/'));
});

app.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('auth', { title: 'Log in', mode: 'login', error: null, username: '', next: back(req, '/') });
});

app.post('/login', limit('login', 10, 600e3), async (req, res) => {
  const username = clean(req.body.username, 32);
  const user = q.userByName.get(username);
  const ok = user ? await verifyPassword(String(req.body.password || ''), user.pass_hash) : false;
  let error = null;
  if (!ok) error = 'Wrong username or password.';
  else if (user.banned) error = 'This account is banned' + (user.ban_reason ? ': ' + user.ban_reason : '.');
  if (error) return res.status(400).render('auth', { title: 'Log in', mode: 'login', error, username, next: back(req, '/') });
  startSession(res, user.id);
  res.redirect(back(req, '/'));
});

app.get('/forgot', (req, res) => res.render('forgot', { title: 'Reset password', sent: false }));

app.post('/forgot', limit('forgot', 5, 3600e3), async (req, res) => {
  const email = clean(req.body.email, 254).toLowerCase();
  const user = EMAIL_RE.test(email) ? db.prepare('SELECT id, username, banned FROM users WHERE email = ? COLLATE NOCASE').get(email) : null;
  // Same answer whether or not the address is known, so this cannot be used to look up who has an account.
  if (user && !user.banned) {
    const t = token();
    db.prepare('DELETE FROM password_resets WHERE user_id = ? OR expires_at < ?').run(user.id, Date.now());
    db.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?,?,?)').run(sha256(t), user.id, Date.now() + RESET_MS);
    const text = `Hi ${user.username},\n\nSomeone asked to reset the password for your ${SITE} account. To choose a new one, open this link within an hour:\n\n${SITE_URL}/reset/${t}\n\nIf that was not you, ignore this email and nothing changes.\n`;
    try { await mail.send(email, `Reset your ${SITE} password`, text); } catch (e) { console.error('reset email failed:', e.message); }
  }
  res.render('forgot', { title: 'Reset password', sent: true });
});

const findReset = (t) => /^[a-f0-9]{64}$/.test(t)
  ? db.prepare('SELECT r.user_id, u.username FROM password_resets r JOIN users u ON u.id = r.user_id WHERE r.token_hash = ? AND r.expires_at > ?').get(sha256(t), Date.now())
  : null;

app.get('/reset/:token', (req, res) => {
  const r = findReset(req.params.token);
  if (!r) return fail(res, 400, 'That reset link has expired or was already used. Ask for a new one.');
  res.render('reset', { title: 'Choose a new password', token: req.params.token, username: r.username, error: null });
});

app.post('/reset/:token', limit('reset', 10, 3600e3), async (req, res) => {
  const r = findReset(req.params.token);
  if (!r) return fail(res, 400, 'That reset link has expired or was already used. Ask for a new one.');
  const password = String(req.body.password || '');
  let error = null;
  if (password.length < 8 || password.length > 200) error = 'Password must be at least 8 characters.';
  else if (password !== String(req.body.password2 || '')) error = 'Passwords do not match.';
  if (error) return res.status(400).render('reset', { title: 'Choose a new password', token: req.params.token, username: r.username, error });
  db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(await hashPassword(password), r.user_id);
  db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(r.user_id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(r.user_id);
  flash(res, 'Password changed. Log in with the new one.');
  res.redirect('/login');
});

app.post('/logout', (req, res) => {
  if (req.cookies.sid) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.cookies.sid);
  setCookie(res, 'sid', '', 0);
  res.redirect('/');
});

/* ---------- forums ---------- */
const FORUM_SORTS = {
  active: 't.last_post_at DESC',
  new: 't.created_at DESC',
  low: 't.price_cents IS NULL, t.price_cents ASC',
  high: 't.price_cents DESC',
};

app.get('/f/:slug', (req, res) => {
  const forum = q.forumBySlug.get(req.params.slug);
  if (!forum) return fail(res, 404, 'Forum not found.');
  const f = {
    type: forum.is_market && LISTING_TYPES[req.query.type] ? req.query.type : '',
    status: forum.is_market && STATUSES[req.query.status] ? req.query.status : '',
    sort: FORUM_SORTS[req.query.sort] && (forum.is_market || ['active', 'new'].includes(req.query.sort)) ? req.query.sort : 'active',
  };
  const where = ['t.forum_id = ?', 't.deleted = 0'];
  const args = [forum.id];
  if (f.type) { where.push('t.listing_type = ?'); args.push(f.type); }
  if (f.status) { where.push('t.status = ?'); args.push(f.status); }
  const total = db.prepare(`SELECT COUNT(*) AS c FROM threads t WHERE ${where.join(' AND ')}`).get(...args).c;
  const pg = paging(req, total);
  const threads = db.prepare(`${THREAD_SELECT} WHERE ${where.join(' AND ')}
    ORDER BY t.pinned DESC, ${FORUM_SORTS[f.sort]} LIMIT ? OFFSET ?`).all(...args, PER_PAGE, pg.offset);
  res.render('forum', { title: forum.name, forum, threads, pg, f, navSlug: forum.slug });
});

function canPostIn(forum, user) {
  return !forum.staff_only || isMod(user);
}

// Reads and validates the new/edit thread form.
function readThreadForm(req, forum) {
  const v = {
    title: clean(req.body.title, 120),
    body: clean(req.body.body, 10000),
    listing_type: String(req.body.listing_type || ''),
    handle: clean(req.body.handle, 64).replace(/^@+/, ''),
    price: clean(req.body.price, 16),
  };
  let error = null;
  let priceCents = null;
  if (v.title.length < 4) error = 'Title is too short.';
  else if (v.body.length < 10) error = 'Write a bit more in the description (at least 10 characters).';
  else if (forum.is_market) {
    if (!LISTING_TYPES[v.listing_type]) error = 'Choose whether you are selling or buying.';
    else if (!v.handle) error = 'Enter the username this listing is about.';
    else if (/\s/.test(v.handle)) error = 'The username cannot contain spaces.';
    else if (v.price !== '') {
      const n = Number(v.price.replace(/[$,]/g, ''));
      if (!Number.isFinite(n) || n < 0 || n > 10_000_000) error = 'Price must be a number in USD (or leave blank for offers).';
      else priceCents = Math.round(n * 100);
    }
  }
  return { v, error, priceCents };
}

app.get('/f/:slug/new', requireLogin, (req, res) => {
  const forum = q.forumBySlug.get(req.params.slug);
  if (!forum) return fail(res, 404, 'Forum not found.');
  if (!canPostIn(forum, req.user)) return fail(res, 403, 'Only staff can post in this forum.');
  res.render('new_thread', { title: 'New thread', forum, error: null, v: {}, edit: null, navSlug: forum.slug });
});

app.post('/f/:slug/new', requireLogin, limit('thread', 6, 600e3), (req, res) => {
  const forum = q.forumBySlug.get(req.params.slug);
  if (!forum) return fail(res, 404, 'Forum not found.');
  if (!canPostIn(forum, req.user)) return fail(res, 403, 'Only staff can post in this forum.');
  const { v, error, priceCents } = readThreadForm(req, forum);
  if (error) return res.status(400).render('new_thread', { title: 'New thread', forum, error, v, edit: null, navSlug: forum.slug });

  const now = Date.now();
  const info = db.prepare(`INSERT INTO threads
    (forum_id, user_id, title, body, created_at, last_post_at, listing_type, handle, price_cents)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    forum.id, req.user.id, v.title, v.body, now, now,
    forum.is_market ? v.listing_type : null, forum.is_market ? v.handle : null, priceCents
  );
  res.redirect('/t/' + info.lastInsertRowid);
});

/* ---------- market + search ---------- */
function marketFilters(query) {
  return {
    q: clean(query.q, 64).replace(/^@+/, ''),
    seller: clean(query.seller, 64),
    platform: clean(query.platform, 32),
    type: typeof query.type === 'string' && Object.hasOwn(LISTING_TYPES, query.type) ? query.type : '',
    status: typeof query.status === 'string' && (Object.hasOwn(STATUSES, query.status) || query.status === 'all') ? query.status : 'open',
    max: clean(query.max, 12),
    sort: ['new', 'low', 'high'].includes(query.sort) ? query.sort : 'new',
    stock: query.stock === '1' ? '1' : '',
  };
}
app.get('/market', (req, res) => {
  const f = marketFilters(req.query);
  const where = ['t.deleted = 0', 'f.is_market = 1'];
  const args = [];
  if (f.q) { where.push("(t.handle LIKE ? ESCAPE '\\' OR t.title LIKE ? ESCAPE '\\')"); const p = '%' + likeEscape(f.q) + '%'; args.push(p, p); }
  if (f.platform) { where.push('f.slug = ?'); args.push(f.platform); }
  if (f.seller) { where.push('u.username = ?'); args.push(f.seller); }
  if (f.type) { where.push('t.listing_type = ?'); args.push(f.type); }
  if (f.stock) where.push("u.role != 'member' AND t.listing_type = 'sell'");
  if (f.status !== 'all') { where.push('t.status = ?'); args.push(f.status); }
  const max = Number(f.max);
  if (f.max !== '' && Number.isFinite(max) && max >= 0) { where.push('t.price_cents <= ?'); args.push(Math.round(max * 100)); }
  const order = { new: 't.last_post_at DESC', low: 't.price_cents IS NULL, t.price_cents ASC', high: 't.price_cents DESC' }[f.sort];
  const from = 'FROM threads t JOIN forums f ON f.id = t.forum_id JOIN users u ON u.id = t.user_id';
  const total = db.prepare(`SELECT COUNT(*) AS c ${from} WHERE ${where.join(' AND ')}`).get(...args).c;
  const pg = paging(req, total);
  const threads = db.prepare(`${THREAD_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...args, PER_PAGE, pg.offset);
  const filtered = !!(f.q || f.seller || f.platform || f.type || f.max || f.stock || f.status !== 'open' || f.sort !== 'new');
  const canSaveSearch = !!(sandbox.enabled && req.user && memberships.current(req.user.id).plan !== 'free');
  res.render('market', { title: 'Market', threads, pg, f, filtered, canSaveSearch });
});

app.get('/search', (req, res) => {
  const s = clean(req.query.q, 64).replace(/^@+/, '');
  if (s.length < 2) return res.render('search', { title: 'Search', s, members: [], threads: [], pg: null, searchQ: s });
  const p = '%' + likeEscape(s) + '%';
  const members = db.prepare(`SELECT u.username, u.role, u.last_seen, u.created_at, ${USER_STATS}
    FROM users u WHERE u.retired_at IS NULL AND u.username LIKE ? ESCAPE '\\' ORDER BY u.username = ? DESC, u.username LIMIT 12`).all(p, s);
  const where = "t.deleted = 0 AND (t.title LIKE ? ESCAPE '\\' OR t.handle LIKE ? ESCAPE '\\')";
  const total = db.prepare(`SELECT COUNT(*) AS c FROM threads t WHERE ${where}`).get(p, p).c;
  const pg = paging(req, total);
  const threads = db.prepare(`${THREAD_SELECT} WHERE ${where}
    ORDER BY t.handle = ? COLLATE NOCASE DESC, t.status = 'open' DESC, t.last_post_at DESC LIMIT ? OFFSET ?`)
    .all(p, p, s, PER_PAGE, pg.offset);
  res.render('search', { title: 'Search: ' + s, s, members, threads, pg, searchQ: s });
});

/* ---------- threads ---------- */
app.get('/t/:id', (req, res) => {
  const thread = q.thread.get(Number(req.params.id) || 0);
  if (!thread) return fail(res, 404, 'Thread not found.');
  db.prepare('UPDATE threads SET views = views + 1 WHERE id = ?').run(thread.id);
  const pg = paging(req, thread.reply_count);
  const op = db.prepare(`SELECT u.id, u.username, u.role, u.banned, u.created_at, u.last_seen, ${USER_STATS} FROM users u WHERE u.id = ?`).get(thread.user_id);
  const posts = db.prepare(`
    SELECT p.*, u.username, u.role, u.created_at AS joined, u.last_seen, ${USER_STATS}
    FROM posts p JOIN users u ON u.id = p.user_id
    WHERE p.thread_id = ? AND p.deleted = 0 ORDER BY p.id LIMIT ? OFFSET ?`).all(thread.id, PER_PAGE, pg.offset);

  let extra = null;
  if (thread.is_market && thread.listing_type) {
    const now = Date.now();
    extra = {
      fb: q.fbCounts.get(op.id),
      openCount: db.prepare(`SELECT COUNT(*) AS c FROM threads t JOIN forums f ON f.id = t.forum_id
        WHERE t.user_id = ? AND t.deleted = 0 AND f.is_market = 1 AND t.status = 'open'`).get(op.id).c,
      saves: db.prepare('SELECT COUNT(*) AS c FROM saves WHERE thread_id = ?').get(thread.id).c,
      saved: req.user ? !!db.prepare('SELECT 1 AS x FROM saves WHERE user_id = ? AND thread_id = ?').get(req.user.id, thread.id) : false,
      canBump: thread.status === 'open' && (!thread.bumped_at || now - thread.bumped_at > DAY),
      nextBump: thread.bumped_at ? thread.bumped_at + DAY : 0,
      more: db.prepare(`${THREAD_SELECT} WHERE t.user_id = ? AND t.id != ? AND t.deleted = 0 AND f.is_market = 1 AND t.status = 'open'
        ORDER BY t.last_post_at DESC LIMIT 5`).all(op.id, thread.id),
      similar: db.prepare(`${THREAD_SELECT} WHERE t.forum_id = ? AND t.id != ? AND t.user_id != ? AND t.deleted = 0 AND t.status = 'open'
        ORDER BY t.last_post_at DESC LIMIT 5`).all(thread.forum_id, thread.id, op.id),
    };
    if (sandbox.enabled && sandbox.eligible(thread) && !op.banned) {
      extra.checkoutEligible = true;
      extra.checkoutApproved = sandbox.isApproved(thread);
      const order = sandbox.activeFor(thread.id);
      if (order) {
        extra.checkoutStatus = order.status;
        if (req.user && sandbox.getOrder(order.id, req.user)) extra.checkoutOrderId = order.id;
      }
    }
  }
  res.render('thread', { title: (thread.handle ? '@' + thread.handle + ' — ' : '') + thread.title, thread, op, posts, pg, extra, navSlug: thread.forum_slug });
});

app.post('/t/:id/reply', requireLogin, limit('reply', 20, 600e3), (req, res) => {
  const thread = q.thread.get(Number(req.params.id) || 0);
  if (!thread) return fail(res, 404, 'Thread not found.');
  if (thread.locked && !isMod(req.user)) return fail(res, 403, 'This thread is locked.');
  const body = clean(req.body.body, 10000);
  if (body.length < 2) return fail(res, 400, 'Your reply is empty.');
  const now = Date.now();
  const info = db.prepare('INSERT INTO posts (thread_id, user_id, body, created_at) VALUES (?,?,?,?)').run(thread.id, req.user.id, body, now);
  db.prepare('UPDATE threads SET reply_count = reply_count + 1, last_post_at = ?, last_post_user_id = ? WHERE id = ?')
    .run(now, req.user.id, thread.id);
  notify(thread.user_id, 'reply', req.user.id, thread.id, info.lastInsertRowid);
  const lastPage = Math.ceil((thread.reply_count + 1) / PER_PAGE);
  res.redirect(`/t/${thread.id}${lastPage > 1 ? '?page=' + lastPage : ''}#p${info.lastInsertRowid}`);
});

app.get('/t/:id/edit', requireLogin, (req, res) => {
  const thread = q.thread.get(Number(req.params.id) || 0);
  if (!thread) return fail(res, 404, 'Thread not found.');
  if (thread.user_id !== req.user.id && !isMod(req.user)) return fail(res, 403, 'Not your thread.');
  const v = {
    title: thread.title, body: thread.body, listing_type: thread.listing_type, handle: thread.handle,
    price: thread.price_cents == null ? '' : String(thread.price_cents / 100),
  };
  res.render('new_thread', { title: 'Edit', forum: q.forumBySlug.get(thread.forum_slug), error: null, v, edit: thread.id, navSlug: thread.forum_slug });
});

app.post('/t/:id/edit', requireLogin, (req, res) => {
  const thread = q.thread.get(Number(req.params.id) || 0);
  if (!thread) return fail(res, 404, 'Thread not found.');
  if (thread.user_id !== req.user.id && !isMod(req.user)) return fail(res, 403, 'Not your thread.');
  const forum = q.forumBySlug.get(thread.forum_slug);
  const { v, error, priceCents } = readThreadForm(req, forum);
  if (error) return res.status(400).render('new_thread', { title: 'Edit', forum, error, v, edit: thread.id, navSlug: forum.slug });
  const saved = sandbox.transaction(() => {
    const current = q.thread.get(thread.id);
    if (!current || sandbox.lockListing(thread.id)) return false;
    db.prepare('UPDATE threads SET title = ?, body = ?, listing_type = ?, handle = ?, price_cents = ?, edited_at = ? WHERE id = ?').run(
      v.title, v.body, forum.is_market ? v.listing_type : null, forum.is_market ? v.handle : null, priceCents,
      Math.max(Date.now(), (current.edited_at || 0) + 1), thread.id
    );
    if (sandbox.enabled && forum.is_market && current.status === 'open' && current.listing_type === 'sell' &&
        v.listing_type === 'sell' && current.handle?.toLowerCase() === v.handle.toLowerCase() &&
        priceCents != null && current.price_cents != null && priceCents < current.price_cents) {
      const watchers = db.prepare(`SELECT s.user_id FROM saves s JOIN sandbox_memberships m ON m.user_id = s.user_id
        WHERE s.thread_id = ? AND m.plan IN ('plus', 'pro') AND m.expires_at > ?`).all(thread.id, Date.now());
      for (const watcher of watchers) notify(watcher.user_id, 'price_drop', req.user.id, thread.id);
    }
    return true;
  });
  if (!saved) return fail(res, 409, 'This listing is unavailable for editing.');
  flash(res, 'Changes saved.');
  res.redirect('/t/' + thread.id);
});

// Listing owner (or staff) marks a listing open / sold / closed.
function setListingStatus(thread, status, actorId) {
  db.prepare('UPDATE threads SET status = ?, status_at = ? WHERE id = ?').run(status, Date.now(), thread.id);
  for (const s of db.prepare('SELECT user_id FROM saves WHERE thread_id = ?').all(thread.id)) {
    notify(s.user_id, 'status', actorId, thread.id);
  }
}
app.post('/t/:id/status', requireLogin, (req, res) => {
  const thread = q.thread.get(Number(req.params.id) || 0);
  if (!thread) return fail(res, 404, 'Thread not found.');
  if (thread.user_id !== req.user.id && !isMod(req.user)) return fail(res, 403, 'Not your listing.');
  const status = String(req.body.status || '');
  if (!thread.is_market || !Object.hasOwn(STATUSES, status)) return fail(res, 400, 'Invalid status.');
  if (status !== thread.status) {
    if (sandbox.lockListing(thread.id)) return fail(res, 409, 'This listing has an active test order.');
    setListingStatus(thread, status, req.user.id);
    flash(res, `Listing marked ${STATUSES[status].toLowerCase()}.`);
  }
  res.redirect(back(req, '/t/' + thread.id));
});

// Owner can push an open listing back to the top once a day.
app.post('/t/:id/bump', requireLogin, (req, res) => {
  const thread = q.thread.get(Number(req.params.id) || 0);
  if (!thread) return fail(res, 404, 'Thread not found.');
  if (thread.user_id !== req.user.id) return fail(res, 403, 'Not your listing.');
  if (!thread.is_market || thread.status !== 'open') return fail(res, 400, 'Only open listings can be bumped.');
  const now = Date.now();
  if (thread.bumped_at && now - thread.bumped_at < DAY) return fail(res, 429, 'You can bump a listing once every 24 hours.');
  db.prepare('UPDATE threads SET bumped_at = ?, last_post_at = ? WHERE id = ?').run(now, now, thread.id);
  flash(res, 'Listing bumped to the top.');
  res.redirect(back(req, '/t/' + thread.id));
});

app.post('/t/:id/save', requireLogin, (req, res) => {
  const thread = q.thread.get(Number(req.params.id) || 0);
  if (!thread) return fail(res, 404, 'Thread not found.');
  const del = db.prepare('DELETE FROM saves WHERE user_id = ? AND thread_id = ?').run(req.user.id, thread.id);
  if (!del.changes) {
    db.prepare('INSERT INTO saves (user_id, thread_id, created_at) VALUES (?,?,?)').run(req.user.id, thread.id, Date.now());
    flash(res, 'Saved. You will get an alert if its status changes.');
  } else flash(res, 'Removed from your saved list.');
  res.redirect(back(req, '/t/' + thread.id));
});

app.post('/t/:id/mod', requireLogin, requireMod, (req, res) => {
  const thread = q.thread.get(Number(req.params.id) || 0);
  if (!thread) return fail(res, 404, 'Thread not found.');
  const sql = {
    pin: 'pinned = 1', unpin: 'pinned = 0', lock: 'locked = 1', unlock: 'locked = 0', delete: 'deleted = 1',
  }[req.body.action];
  if (!sql) return fail(res, 400, 'Unknown action.');
  db.prepare(`UPDATE threads SET ${sql} WHERE id = ?`).run(thread.id);
  if (req.body.action === 'delete') {
    flash(res, 'Thread deleted.');
    return res.redirect('/f/' + thread.forum_slug);
  }
  res.redirect('/t/' + thread.id);
});

// Thread starter can delete their own thread.
app.post('/t/:id/delete', requireLogin, (req, res) => {
  const thread = q.thread.get(Number(req.params.id) || 0);
  if (!thread) return fail(res, 404, 'Thread not found.');
  if (thread.user_id !== req.user.id && !isMod(req.user)) return fail(res, 403, 'Not your thread.');
  if (sandbox.lockListing(thread.id)) return fail(res, 409, 'This listing has an active test order.');
  db.prepare('UPDATE threads SET deleted = 1 WHERE id = ?').run(thread.id);
  flash(res, 'Thread deleted.');
  res.redirect('/f/' + thread.forum_slug);
});

function ownPost(req, res) {
  const post = db.prepare('SELECT * FROM posts WHERE id = ? AND deleted = 0').get(Number(req.params.id) || 0);
  if (!post) { fail(res, 404, 'Post not found.'); return null; }
  if (post.user_id !== req.user.id && !isMod(req.user)) { fail(res, 403, 'Not your post.'); return null; }
  return post;
}

app.get('/p/:id/edit', requireLogin, (req, res) => {
  const post = ownPost(req, res);
  if (post) res.render('edit_post', { title: 'Edit reply', post, error: null });
});

app.post('/p/:id/edit', requireLogin, (req, res) => {
  const post = ownPost(req, res);
  if (!post) return;
  const body = clean(req.body.body, 10000);
  if (body.length < 2) return res.status(400).render('edit_post', { title: 'Edit reply', post, error: 'Your reply is empty.' });
  db.prepare('UPDATE posts SET body = ?, edited_at = ? WHERE id = ?').run(body, Date.now(), post.id);
  res.redirect(`/t/${post.thread_id}#p${post.id}`);
});

app.post('/p/:id/delete', requireLogin, (req, res) => {
  const post = ownPost(req, res);
  if (!post) return;
  db.prepare('UPDATE posts SET deleted = 1 WHERE id = ?').run(post.id);
  db.prepare('UPDATE threads SET reply_count = MAX(reply_count - 1, 0) WHERE id = ?').run(post.thread_id);
  res.redirect('/t/' + post.thread_id);
});

/* ---------- my stuff ---------- */
app.get('/my/listings', requireLogin, (req, res) => {
  const all = db.prepare(`${THREAD_SELECT} WHERE t.user_id = ? AND t.deleted = 0
    ORDER BY t.status = 'open' DESC, t.last_post_at DESC LIMIT 200`).all(req.user.id);
  const now = Date.now();
  for (const t of all) t.canBump = t.status === 'open' && (!t.bumped_at || now - t.bumped_at > DAY);
  const pro = sandbox.enabled && memberships.current(req.user.id).plan === 'pro';
  const listings = all.filter((t) => t.listing_type);
  const insights = pro ? db.prepare(`SELECT COALESCE(SUM(t.views), 0) AS views,
    COALESCE(SUM(t.status = 'sold' AND t.listing_type = 'sell'), 0) AS sold,
    COALESCE(SUM((SELECT COUNT(*) FROM saves s WHERE s.thread_id = t.id)), 0) AS saves
    FROM threads t WHERE t.user_id = ? AND t.deleted = 0 AND t.listing_type IS NOT NULL`).get(req.user.id) : null;
  if (pro) {
    const metrics = db.prepare(`SELECT (SELECT COUNT(*) FROM saves WHERE thread_id = ?) AS saves,
      EXISTS (SELECT 1 FROM sandbox_orders WHERE thread_id = ? AND status = 'paid_out') AS test_sale`);
    for (const listing of listings) Object.assign(listing, metrics.get(listing.id, listing.id));
    insights.test_sales = db.prepare(`SELECT COUNT(*) AS c FROM sandbox_orders
      WHERE seller_id = ? AND status = 'paid_out'`).get(req.user.id).c;
  }
  res.render('my_listings', { title: 'My listings', listings, threads: all.filter((t) => !t.listing_type),
    canExport: pro, insights });
});

app.get('/saved', requireLogin, (req, res) => {
  const threads = db.prepare(`${THREAD_SELECT} JOIN saves s ON s.thread_id = t.id AND s.user_id = ?
    WHERE t.deleted = 0 ORDER BY s.created_at DESC LIMIT 200`).all(req.user.id);
  res.render('saved', { title: 'Saved listings', threads });
});

app.get('/notifications', requireLogin, (req, res) => {
  let items = db.prepare(`SELECT n.*, a.username AS actor, t.title, t.handle, t.status, b.handle AS broker_handle
    FROM notifications n LEFT JOIN users a ON a.id = n.actor_id LEFT JOIN threads t ON t.id = n.thread_id
    LEFT JOIN broker_requests b ON b.id = n.broker_request_id
    WHERE n.user_id = ? ORDER BY n.id DESC LIMIT 60`).all(req.user.id);
  db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0').run(req.user.id);
  if (sandbox.enabled) items = items.concat(sandbox.readAlerts(req.user.id)).sort((a, b) => b.created_at - a.created_at).slice(0, 60);
  res.locals.alerts = 0;
  res.render('notifications', { title: 'Alerts', items });
});

/* ---------- members, profiles, feedback ---------- */
const MEMBER_SORTS = {
  rep: 'rep DESC, u.id', posts: 'post_count DESC, u.id', new: 'u.created_at DESC', name: 'u.username COLLATE NOCASE', seen: 'u.last_seen DESC',
};

const FRAGMENT_SORTS = { new: 'ending', low: 'price_asc', high: 'price_desc', az: '' };
const FRAGMENT_STATUSES = { sale: 'For sale', auction: 'On auction', sold: 'Sold', available: 'Available', unavailable: 'Unavailable' };
const cachedFragmentListings = db.prepare(`SELECT handle, url, price_ton AS price, price_kind AS kind, ends_at AS date,
  CASE WHEN price_kind = 'sale' THEN 'For sale' WHEN ends_at IS NULL THEN 'Available' ELSE 'On auction' END AS status
  FROM external_listings WHERE source = 'fragment' AND (ends_at IS NULL OR ends_at > ?)`);

app.get('/fragment', async (req, res) => {
  const sort = typeof req.query.sort === 'string' && Object.hasOwn(FRAGMENT_SORTS, req.query.sort) ? req.query.sort : 'new';
  const status = typeof req.query.status === 'string' && Object.hasOwn(FRAGMENT_STATUSES, req.query.status) ? req.query.status : '';
  const s = clean(req.query.q, 33).replace(/^@/, '').toLowerCase();
  const len = [4, 5, 6, 7, 8].includes(Number(req.query.len)) ? Number(req.query.len) : 0;
  const offset = typeof req.query.offset === 'string' && /^[1-9]\d{0,7}$/.test(req.query.offset) ? req.query.offset : '';
  const searchOnly = status === 'available' || status === 'unavailable';
  const options = { query: s, sort: FRAGMENT_SORTS[sort], filter: searchOnly ? '' : status, offset };
  const lookupUrl = fragment.HANDLE_RE.test(s) ? fragment.listingUrl(s) : fragment.searchUrl(options).href;
  let lookupUnavailable = false;
  let listings = [];
  let nextOffset = '';
  if (s ? /^[a-z0-9_]{1,32}$/.test(s) : !searchOnly) {
    try {
      ({ listings, nextOffset } = await fragment.searchListings(options));
    } catch {
      lookupUnavailable = true;
      if (!offset) listings = cachedFragmentListings.all(Date.now()).filter((item) => item.handle.includes(s));
    }
  }
  listings = listings.filter((item) => (!status || item.status === FRAGMENT_STATUSES[status]) && (!len || item.handle.length === len));
  if (sort === 'az') listings.sort((a, b) => a.handle.localeCompare(b.handle));
  if (lookupUnavailable && sort === 'low') listings.sort((a, b) => a.price - b.price);
  if (lookupUnavailable && sort === 'high') listings.sort((a, b) => b.price - a.price);
  if (lookupUnavailable && sort === 'new') listings.sort((a, b) => (a.date ?? Infinity) - (b.date ?? Infinity));
  const exactIndex = listings.findIndex((item) => item.handle === s);
  if (exactIndex > 0) listings.unshift(listings.splice(exactIndex, 1)[0]);
  const pg = paging(req, listings.length, 50);
  const rows = listings.slice(pg.offset, pg.offset + 50);
  const statuses = FRAGMENT_STATUSES;
  res.render('fragment', { title: 'On Fragment', rows, pg, sort, s, len, status, statuses, offset, nextOffset,
    lookupUrl, lookupUnavailable, searchOnly, canBroker: fragment.canBroker });
});

async function loadBrokerListing(req, res, next) {
  const handle = clean(req.method === 'GET' ? req.query.h : req.body.handle, 33).toLowerCase();
  if (!fragment.HANDLE_RE.test(handle)) return fail(res, 404, 'That Fragment username is unavailable.');
  let listing;
  try {
    const { listings } = await fragment.searchListings({ query: handle });
    listing = listings.find((item) => item.handle === handle);
  } catch {
    return fail(res, 503, 'Fragment is temporarily unavailable. Try again shortly.');
  }
  if (!listing || !fragment.canBroker(listing)) return fail(res, 404, 'That Fragment username is unavailable.');
  req.fragmentListing = { ...listing, price_ton: listing.price, price_kind: listing.kind };
  next();
}
app.get('/broker', requireLogin, loadBrokerListing, (req, res) => {
  const item = req.fragmentListing;
  res.render('broker', { title: 'Broker request', item, error: null, v: {} });
});

app.post('/broker', requireLogin, limit('broker', 5, 3600e3), loadBrokerListing, (req, res) => {
  const item = req.fragmentListing;
  const v = { budget: clean(req.body.budget, 40), note: clean(req.body.note, 500) };
  const dupe = db.prepare("SELECT 1 FROM broker_requests WHERE user_id = ? AND handle = ? AND status = 'open'").get(req.user.id, item.handle);
  if (dupe) {
    res.status(400);
    return res.render('broker', { title: 'Broker request', item, error: 'You already have an open request for this name.', v });
  }
  const ticket = db.prepare(`INSERT INTO broker_requests (user_id, source, handle, price_ton, budget, note, created_at)
    VALUES (?, 'fragment', ?, ?, ?, ?, ?)`).run(req.user.id, item.handle, item.price_ton, v.budget, v.note, Date.now());
  flash(res, `Request sent for @${item.handle}.`);
  res.redirect('/broker/requests/' + ticket.lastInsertRowid);
});

app.get('/broker/requests', requireLogin, (req, res) => {
  const total = db.prepare('SELECT COUNT(*) AS c FROM broker_requests WHERE user_id = ?').get(req.user.id).c;
  const pg = paging(req, total);
  const tickets = db.prepare(`SELECT id, handle, status, created_at FROM broker_requests
    WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`).all(req.user.id, pg.perPage, pg.offset);
  res.render('broker_requests', { title: 'My broker requests', tickets, pg });
});

function loadBrokerTicket(req, res, next) {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return fail(res, 404, 'Broker request not found.');
  const ticket = db.prepare(`SELECT b.*, u.username AS requester FROM broker_requests b
    JOIN users u ON u.id = b.user_id WHERE b.id = ?`).get(id);
  if (!ticket || (ticket.user_id !== req.user.id && !isMod(req.user))) {
    return fail(res, 404, 'Broker request not found.');
  }
  const fromQueue = isMod(req.user) && (req.query.from === 'queue' || ticket.user_id !== req.user.id);
  const show = queueView(req.query.show);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const context = fromQueue ? '?' + new URLSearchParams({ from: 'queue', show, page }) : '';
  req.brokerTicket = ticket;
  res.locals.ticketUrl = '/broker/requests/' + id + context;
  res.locals.ticketBack = fromQueue ? queueUrl('brokers', show, page) : '/broker/requests';
  res.locals.ticketBackLabel = fromQueue ? 'Broker queue' : 'My broker requests';
  next();
}

app.get('/broker/requests/:id', requireLogin, loadBrokerTicket, (req, res) => {
  const ticket = req.brokerTicket;
  const replies = db.prepare(`SELECT r.*, u.username FROM broker_replies r JOIN users u ON u.id = r.author_id
    WHERE r.request_id = ? ORDER BY r.id`).all(ticket.id);
  res.render('broker_ticket', { title: 'Broker request #' + ticket.id, ticket, replies });
});

app.post('/broker/requests/:id', requireLogin, loadBrokerTicket, limit('broker-reply', 30, 600e3), (req, res) => {
  const ticket = req.brokerTicket;
  const body = clean(req.body.body, 4000);
  if (!body) return fail(res, 400, 'Write a reply before sending.');

  db.exec('BEGIN IMMEDIATE');
  let reply;
  try {
    reply = db.prepare(`INSERT INTO broker_replies (request_id, author_id, body, created_at)
      SELECT id, ?, ?, ? FROM broker_requests WHERE id = ? AND status = 'open'`)
      .run(req.user.id, body, Date.now(), ticket.id);
    if (reply.changes) {
      if (req.user.id === ticket.user_id) {
        const staff = db.prepare(`SELECT DISTINCT u.id FROM broker_replies r JOIN users u ON u.id = r.author_id
          WHERE r.request_id = ? AND u.id <> ? AND u.banned = 0 AND u.role IN ('mod', 'admin')`).all(ticket.id, ticket.user_id);
        for (const member of staff) notify(member.id, 'broker_reply', req.user.id, null, null, ticket.id);
      } else {
        notify(ticket.user_id, 'broker_reply', req.user.id, null, null, ticket.id);
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  if (!reply.changes) return fail(res, 409, 'This broker request is already completed.');
  res.redirect(res.locals.ticketUrl + '#reply-' + reply.lastInsertRowid);
});

app.get('/members', (req, res) => {
  const sort = MEMBER_SORTS[req.query.sort] ? req.query.sort : 'rep';
  const s = clean(req.query.q, 32);
  const where = "WHERE u.retired_at IS NULL" + (s ? " AND u.username LIKE ? ESCAPE '\\'" : '');
  const args = s ? ['%' + likeEscape(s) + '%'] : [];
  const total = db.prepare(`SELECT COUNT(*) AS c FROM users u ${where}`).get(...args).c;
  const pg = paging(req, total, 30);
  const members = db.prepare(`SELECT u.username, u.role, u.banned, u.created_at, u.last_seen, ${USER_STATS}
    FROM users u ${where} ORDER BY ${MEMBER_SORTS[sort]} LIMIT ? OFFSET ?`).all(...args, 30, pg.offset);
  res.render('members', { title: 'Members', members, pg, sort, s });
});

const FEEDBACK_FILTERS = new Map([['pos', 'v.rating > 0'], ['neu', 'v.rating = 0'], ['neg', 'v.rating < 0']]);

app.get('/u/:username/avatar', (req, res) => {
  const avatar = db.prepare(`SELECT a.image FROM user_avatars a JOIN users u ON u.id = a.user_id
    WHERE u.username = ? AND u.retired_at IS NULL`).get(req.params.username);
  res.set('Cache-Control', 'no-cache');
  if (!avatar) return res.status(404).end();
  res.type('image/webp').send(Buffer.from(avatar.image));
});

app.get('/u/:username', (req, res) => {
  const user = db.prepare(`SELECT u.*, ${USER_STATS},
    EXISTS (SELECT 1 FROM user_avatars WHERE user_id = u.id) AS has_avatar
    FROM users u WHERE u.username = ? AND u.retired_at IS NULL`).get(req.params.username);
  if (!user) return fail(res, 404, 'User not found.');
  const counts = q.fbCounts.get(user.id);
  const fbFilter = FEEDBACK_FILTERS.get(req.query.fb);
  const vouches = db.prepare(`SELECT v.*, u.username, deal.id AS deal_id, deal.handle AS deal_handle
    FROM vouches v JOIN users u ON u.id = v.from_id
    LEFT JOIN threads deal ON deal.id = v.deal_thread_id AND deal.deleted = 0
    WHERE v.to_id = ? AND u.retired_at IS NULL ${fbFilter ? 'AND ' + fbFilter : ''} ORDER BY v.created_at DESC LIMIT 50`).all(user.id);
  const threads = db.prepare(`${THREAD_SELECT} WHERE t.user_id = ? AND t.deleted = 0
    ORDER BY t.status = 'open' DESC, t.created_at DESC LIMIT 15`).all(user.id);
  const deals = db.prepare(`SELECT
    COALESCE(SUM(t.status = 'open'),0) AS open, COALESCE(SUM(t.status = 'sold'),0) AS sold
    FROM threads t JOIN forums f ON f.id = t.forum_id WHERE t.user_id = ? AND t.deleted = 0 AND f.is_market = 1`).get(user.id);
  const mine = req.user ? db.prepare('SELECT * FROM vouches WHERE from_id = ? AND to_id = ?').get(req.user.id, user.id) : null;
  const membership = sandbox.enabled ? memberships.current(user.id) : null;
  res.render('profile', { title: user.username, user, counts, vouches, threads, deals, mine, membership,
    membershipName: membership ? memberships.plans[membership.plan].name : '', fbFilter: fbFilter ? req.query.fb : '' });
});

function vouchListingId(link) {
  const url = URL.parse(link, SITE_URL);
  if (!url || url.username || url.password) return null;
  const localOrigin = !PROD && [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`].includes(url.origin);
  if (url.origin !== new URL(SITE_URL).origin && !localOrigin) return null;
  const match = /^\/t\/([1-9]\d*)\/?$/.exec(url.pathname);
  const id = match && Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}

app.post('/u/:username/vouch', requireLogin, limit('vouch', 10, 3600e3), (req, res) => {
  const user = q.userByName.get(req.params.username);
  if (!user) return fail(res, 404, 'User not found.');
  if (user.id === req.user.id) return fail(res, 400, 'You cannot leave feedback for yourself.');
  const points = req.body.rating;
  const comment = clean(req.body.comment, 300);
  if (typeof points !== 'string' || !/^(?:[0-5]|-[1-5])$/.test(points)) {
    return fail(res, 400, 'Pick a reputation score from −5 to +5.');
  }
  const rating = Number(points);
  if (comment.length < 5) return fail(res, 400, 'Describe the deal in a few words.');
  const dealId = vouchListingId(clean(req.body.deal, 512));
  const deal = dealId && q.thread.get(dealId);
  if (!deal || !deal.is_market || !deal.listing_type || ![req.user.id, user.id].includes(deal.user_id)) {
    return fail(res, 400, 'Link to a marketplace listing posted by you or this member.');
  }
  db.prepare(`INSERT INTO vouches (from_id, to_id, rating, comment, created_at, deal_thread_id) VALUES (?,?,?,?,?,?)
    ON CONFLICT(from_id, to_id) DO UPDATE SET rating = excluded.rating, comment = excluded.comment,
      created_at = excluded.created_at, deal_thread_id = excluded.deal_thread_id`)
    .run(req.user.id, user.id, rating, comment, Date.now(), dealId);
  notify(user.id, 'vouch', req.user.id);
  flash(res, 'Feedback saved.');
  res.redirect('/u/' + user.username + '#feedback');
});

app.post('/u/:username/ban', requireLogin, requireMod, (req, res) => {
  const user = q.userByName.get(req.params.username);
  if (!user) return fail(res, 404, 'User not found.');
  if (user.id === req.user.id) return fail(res, 400, 'You cannot ban yourself.');
  if (user.role === 'admin' || (user.role === 'mod' && req.user.role !== 'admin')) return fail(res, 403, 'You cannot ban this user.');
  if (req.body.action === 'unban') {
    db.prepare('UPDATE users SET banned = 0, ban_reason = NULL WHERE id = ?').run(user.id);
  } else {
    db.prepare('UPDATE users SET banned = 1, ban_reason = ? WHERE id = ?').run(clean(req.body.reason, 200) || null, user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  }
  res.redirect('/u/' + user.username);
});

app.post('/u/:username/role', requireLogin, (req, res) => {
  if (req.user.role !== 'admin') return fail(res, 403, 'Admins only.');
  const user = q.userByName.get(req.params.username);
  if (!user) return fail(res, 404, 'User not found.');
  if (user.id === req.user.id) return fail(res, 400, 'You cannot change your own role.');
  const role = String(req.body.role || '');
  if (!['member', 'mod', 'admin'].includes(role)) return fail(res, 400, 'Invalid role.');
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, user.id);
  res.redirect('/u/' + user.username);
});

/* ---------- settings ---------- */
app.get('/settings', requireLogin, (req, res) => res.render('settings', { title: 'Settings', error: null }));

app.post('/settings', requireLogin, async (req, res) => {
  if (req.body.form === 'remove-avatar') {
    db.prepare('DELETE FROM user_avatars WHERE user_id = ?').run(req.user.id);
    flash(res, 'Profile picture removed.');
  } else if (req.body.form === 'password') {
    const next = String(req.body.new_password || '');
    let error = null;
    if (!(await verifyPassword(String(req.body.current_password || ''), req.user.pass_hash))) error = 'Current password is wrong.';
    else if (next.length < 8 || next.length > 200) error = 'New password must be at least 8 characters.';
    if (error) return renderSettingsError(res, 400, error);
    db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(await hashPassword(next), req.user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, req.cookies.sid);
    flash(res, 'Password changed. Other devices were logged out.');
  } else if (req.body.form === 'email') {
    const email = clean(req.body.email, 254).toLowerCase();
    let error = null;
    if (!(await verifyPassword(String(req.body.current_password || ''), req.user.pass_hash))) error = 'Current password is wrong.';
    else if (email && !EMAIL_RE.test(email)) error = 'That email address does not look right.';
    else if (email && db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE AND id != ?').get(email, req.user.id)) error = 'That email is already used by another account.';
    if (error) return renderSettingsError(res, 400, error);
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email || null, req.user.id);
    flash(res, email ? 'Email saved.' : 'Email removed.');
  } else {
    db.prepare('UPDATE users SET bio = ?, contact = ? WHERE id = ?')
      .run(clean(req.body.bio, 500), clean(req.body.contact, 200), req.user.id);
    flash(res, 'Profile updated.');
  }
  res.redirect('/settings');
});

/* ---------- private messages ---------- */
app.get('/messages', requireLogin, (req, res) => {
  const me = req.user.id;
  const convos = db.prepare(`
    SELECT u.username, u.last_seen, m.body, m.created_at, m.from_id,
      (SELECT COUNT(*) FROM messages x WHERE x.from_id = u.id AND x.to_id = ? AND x.read = 0) AS unread
    FROM messages m
    JOIN users u ON u.id = CASE WHEN m.from_id = ? THEN m.to_id ELSE m.from_id END
    WHERE u.retired_at IS NULL AND m.id IN (
      SELECT MAX(id) FROM messages WHERE from_id = ? OR to_id = ?
      GROUP BY CASE WHEN from_id = ? THEN to_id ELSE from_id END)
    ORDER BY m.id DESC`).all(me, me, me, me, me);
  res.render('messages', { title: 'Inbox', convos });
});

// "New message" box on the inbox: /messages/to?u=name
app.get('/messages/to', requireLogin, (req, res) => {
  const other = q.userByName.get(clean(req.query.u, 32).replace(/^@+/, ''));
  if (!other || other.id === req.user.id) {
    flash(res, other ? 'You cannot message yourself.' : 'No member with that name.');
    return res.redirect('/messages');
  }
  res.redirect('/messages/' + other.username);
});

app.get('/messages/:username', requireLogin, (req, res) => {
  const other = q.userByName.get(req.params.username);
  if (!other) return fail(res, 404, 'User not found.');
  if (other.id === req.user.id) return res.redirect('/messages');
  const me = req.user.id;
  db.prepare('UPDATE messages SET read = 1 WHERE from_id = ? AND to_id = ? AND read = 0').run(other.id, me);
  const msgs = db.prepare(`SELECT * FROM (
      SELECT * FROM messages WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?) ORDER BY id DESC LIMIT 200
    ) ORDER BY id`).all(me, other.id, other.id, me);
  res.locals.unread = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE to_id = ? AND read = 0').get(me).c;
  // Coming from a listing: start the message with a reference to it.
  let prefill = '';
  const about = q.thread.get(Number(req.query.about) || 0);
  if (about && about.user_id === other.id) {
    prefill = `Hi, about ${about.handle ? '@' + about.handle : 'your thread'} (${req.protocol}://${req.get('host')}/t/${about.id}) — `;
  }
  const stats = db.prepare(`SELECT u.created_at, ${USER_STATS} FROM users u WHERE u.id = ?`).get(other.id);
  res.render('conversation', { title: 'Chat with ' + other.username, other, msgs, prefill, stats });
});

app.post('/messages/:username', requireLogin, limit('pm', 30, 600e3), (req, res) => {
  const other = q.userByName.get(req.params.username);
  if (!other) return fail(res, 404, 'User not found.');
  if (other.id === req.user.id) return fail(res, 400, 'You cannot message yourself.');
  const body = clean(req.body.body, 4000);
  if (!body) return fail(res, 400, 'Your message is empty.');
  db.prepare('INSERT INTO messages (from_id, to_id, body, created_at) VALUES (?,?,?,?)').run(req.user.id, other.id, body, Date.now());
  res.redirect('/messages/' + other.username + '#end');
});

/* ---------- reports + staff queue ---------- */
app.post('/report', requireLogin, limit('report', 10, 3600e3), (req, res) => {
  const kind = String(req.body.kind || '');
  const targetId = Number(req.body.target_id) || 0;
  const reason = clean(req.body.reason, 500);
  if (!['thread', 'post', 'user'].includes(kind) || !targetId) return fail(res, 400, 'Invalid report.');
  if (reason.length < 5) return fail(res, 400, 'Tell staff what is wrong (at least 5 characters).');
  db.prepare('INSERT INTO reports (reporter_id, kind, target_id, reason, created_at) VALUES (?,?,?,?,?)')
    .run(req.user.id, kind, targetId, reason, Date.now());
  flash(res, 'Report sent to staff. Thanks.');
  res.redirect(back(req, '/'));
});

function queueView(show) {
  return show === 'all' || show === 'closed' ? show : 'open';
}

function queueUrl(section, show, page = 1) {
  const params = new URLSearchParams();
  if (section !== 'reports') params.set('section', section);
  if (show !== 'open') params.set('show', show);
  if (page > 1) params.set('page', page);
  return params.size ? '/mod?' + params : '/mod';
}

app.get('/mod', requireLogin, requireMod, (req, res) => {
  const section = ['brokers', 'members'].includes(req.query.section) ? req.query.section : 'reports';
  const show = queueView(req.query.show);
  const counts = db.prepare(`SELECT
    (SELECT COUNT(*) FROM reports WHERE status = 'open') AS reports,
    (SELECT COUNT(*) FROM broker_requests WHERE status = 'open') AS brokers`).get();
  const locals = { title: 'Staff queue', section, show, counts, queueUrl };
  if (section === 'members') {
    const banned = db.prepare('SELECT username, ban_reason FROM users WHERE banned = 1 AND retired_at IS NULL ORDER BY username LIMIT 100').all();
    const newest = db.prepare(`SELECT u.username, u.created_at, ${USER_STATS} FROM users u
      WHERE u.retired_at IS NULL ORDER BY u.id DESC LIMIT 8`).all();
    return res.render('mod', { ...locals, banned, newest });
  }

  const where = show === 'all' ? '' : show === 'closed' ? "WHERE status <> 'open'" : "WHERE status = 'open'";
  const table = section === 'brokers' ? 'broker_requests' : 'reports';
  const total = db.prepare(`SELECT COUNT(*) AS c FROM ${table} ${where}`).get().c;
  const pg = paging(req, total);
  pg.url = (page) => queueUrl(section, show, page);
  if (section === 'brokers') {
    const brokers = db.prepare(`SELECT b.*, u.username AS buyer, h.username AS handler
      FROM (SELECT * FROM broker_requests ${where} ORDER BY id DESC LIMIT ? OFFSET ?) b
      JOIN users u ON u.id = b.user_id LEFT JOIN users h ON h.id = b.handled_by ORDER BY b.id DESC`).all(pg.perPage, pg.offset);
    return res.render('mod', { ...locals, brokers, pg });
  }

  const reports = db.prepare(`SELECT r.*, u.username AS reporter, h.username AS handler
    FROM (SELECT * FROM reports ${where} ORDER BY id DESC LIMIT ? OFFSET ?) r
    JOIN users u ON u.id = r.reporter_id LEFT JOIN users h ON h.id = r.handled_by ORDER BY r.id DESC`).all(pg.perPage, pg.offset);
  for (const r of reports) {
    if (r.kind === 'thread') {
      const t = db.prepare('SELECT id, title FROM threads WHERE id = ? AND deleted = 0').get(r.target_id);
      if (t) { r.link = '/t/' + t.id; r.label = t.title; }
    } else if (r.kind === 'post') {
      const p = db.prepare(`SELECT p.id, p.thread_id, p.body FROM posts p JOIN threads t ON t.id = p.thread_id
        WHERE p.id = ? AND p.deleted = 0 AND t.deleted = 0`).get(r.target_id);
      if (p) { r.link = `/t/${p.thread_id}#p${p.id}`; r.label = p.body.slice(0, 80); }
    } else {
      const u = db.prepare('SELECT username FROM users WHERE id = ?').get(r.target_id);
      if (u) { r.link = '/u/' + u.username; r.label = u.username; }
    }
  }
  res.render('mod', { ...locals, reports, pg });
});

app.post('/mod/broker/:id', requireLogin, requireMod, (req, res) => {
  const result = db.prepare("UPDATE broker_requests SET status = 'done', handled_by = ? WHERE id = ? AND status = 'open'")
    .run(req.user.id, Number(req.params.id) || 0);
  flash(res, result.changes ? 'Broker request marked done.' : 'That broker request is no longer open.');
  res.redirect(queueUrl('brokers', queueView(req.body.show), Number(req.body.page) || 1));
});

app.post('/mod/reports/:id', requireLogin, requireMod, (req, res) => {
  const result = db.prepare("UPDATE reports SET status = 'resolved', handled_by = ? WHERE id = ? AND status = 'open'")
    .run(req.user.id, Number(req.params.id) || 0);
  flash(res, result.changes ? 'Report resolved.' : 'That report is no longer open.');
  res.redirect(queueUrl('reports', queueView(req.body.show), Number(req.body.page) || 1));
});

/* ---------- sandbox checkout ---------- */
function requireSandbox(req, res, next) {
  if (!sandbox.enabled) return fail(res, 404, 'Page not found.');
  next();
}

app.post('/t/:id/checkout/approval', requireSandbox, requireLogin, requireMod, (req, res) => {
  const id = Number(req.params.id) || 0;
  if (req.body.enabled === '1') {
    if (!sandbox.approve(id, req.user.id)) return fail(res, 400, 'Choose an open, fixed-price Telegram collectible listing.');
    flash(res, 'Test checkout approved.');
  } else {
    db.prepare('DELETE FROM sandbox_checkout_listings WHERE thread_id = ?').run(id);
    flash(res, 'Test checkout disabled for this listing.');
  }
  res.redirect('/t/' + id);
});

app.post('/t/:id/checkout', requireSandbox, requireLogin, limit('checkout', 20, 600e3), (req, res) => {
  const id = sandbox.reserve(Number(req.params.id) || 0, req.user.id);
  if (!id) return fail(res, 409, 'This listing is unavailable for test checkout.');
  res.redirect('/orders/' + id);
});

app.get('/orders', requireSandbox, requireLogin, (req, res) => {
  const review = isMod(req.user) && req.query.review === '1';
  const disputes = review && req.query.disputes === '1';
  const where = review ? (disputes ? "WHERE status = 'disputed'" : '') : 'WHERE buyer_id = ? OR seller_id = ?';
  const args = review ? [] : [req.user.id, req.user.id];
  const pg = paging(req, db.prepare(`SELECT COUNT(*) AS c FROM sandbox_orders ${where}`).get(...args).c);
  const orders = db.prepare(`SELECT id, handle, buyer_id, seller_id, price_cents, updated_at,
    CASE WHEN status = 'reserved' AND expires_at <= ? THEN 'expired' ELSE status END AS status
    FROM sandbox_orders ${where} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`).all(Date.now(), ...args, pg.perPage, pg.offset);
  for (const order of orders) order.next = sandbox.nextFor(order, req.user);
  res.render('sandbox_orders', { title: review ? 'Review test orders' : 'My Deals', orders, pg, review, disputes, statuses: sandbox.statuses });
});

app.get('/orders/:id', requireSandbox, requireLogin, (req, res) => {
  const order = sandbox.getOrder(Number(req.params.id) || 0, req.user);
  if (!order) return fail(res, 404, 'Order not found.');
  res.render('sandbox_order', { title: 'Test order #' + order.id, order, status: sandbox.statuses[order.status],
    actions: sandbox.actionsFor(order, req.user), timeline: sandbox.timeline(order), statuses: sandbox.statuses,
    nextStep: sandbox.nextFor(order, req.user), disputeReplies: order.dispute_note ? sandbox.disputeReplies.all(order.id) : [] });
});

app.post('/orders/:id', requireSandbox, requireLogin, limit('order-action', 30, 600e3), (req, res) => {
  const id = Number(req.params.id) || 0;
  const result = sandbox.advance(id, req.user, String(req.body.action || ''), clean(req.body.detail, 500));
  if (result === 404) return fail(res, 404, 'Order not found.');
  if (result === 403) return fail(res, 403, 'You cannot perform that order action.');
  if (result === 400) return fail(res, 400, 'Enter a transfer reference or dispute reason.');
  if (result === 409) return fail(res, 409, 'That action is unavailable in the current order state.');
  res.redirect('/orders/' + id + (req.body.action === 'dispute' ? '#dispute' : ''));
});

app.post('/orders/:id/dispute/replies', requireSandbox, requireLogin, limit('order-dispute', 30, 600e3), (req, res) => {
  const id = Number(req.params.id) || 0;
  const body = clean(req.body.body, 2000);
  if (!body) return fail(res, 400, 'Write a reply before sending.');
  const result = sandbox.replyToDispute(id, req.user, body);
  if (result === 404) return fail(res, 404, 'Order not found.');
  if (result === 409) return fail(res, 409, 'This dispute is closed.');
  res.redirect('/orders/' + id + '#dispute');
});

function requirePaidMembership(req, res, next) {
  if (memberships.current(req.user.id).plan === 'free') return fail(res, 403, 'A Plus or Pro membership is required.');
  next();
}

app.get('/saved/searches', requireSandbox, requireLogin, requirePaidMembership, (req, res) => {
  const searches = db.prepare('SELECT id, name, query FROM sandbox_saved_searches WHERE user_id = ? ORDER BY id DESC').all(req.user.id);
  res.render('saved_searches', { title: 'Saved searches', searches });
});

app.post('/saved/searches', requireSandbox, requireLogin, requirePaidMembership, (req, res) => {
  const filters = marketFilters(req.body);
  const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value)).toString();
  const name = clean(req.body.name, 80) || filters.q || 'Market search';
  const result = db.prepare(`INSERT INTO sandbox_saved_searches (user_id, query, name)
    SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM sandbox_saved_searches WHERE user_id = ?) < 30
    ON CONFLICT(user_id, query) DO NOTHING`).run(req.user.id, query, name, req.user.id);
  flash(res, result.changes ? 'Search saved.' : 'Search already saved or limit of 30 reached.');
  res.redirect('/saved/searches');
});

app.post('/saved/searches/:id/delete', requireSandbox, requireLogin, (req, res) => {
  db.prepare('DELETE FROM sandbox_saved_searches WHERE id = ? AND user_id = ?').run(Number(req.params.id) || 0, req.user.id);
  res.redirect('/saved/searches');
});

app.post('/my/listings/bulk', requireSandbox, requireLogin, (req, res) => {
  if (memberships.current(req.user.id).plan !== 'pro') return fail(res, 403, 'A Pro membership is required.');
  const status = req.body.status;
  if (!['open', 'closed'].includes(status)) return fail(res, 400, 'Choose open or closed.');
  const ids = [...new Set([req.body.listing].flat().map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (!ids.length || ids.length > 200) return fail(res, 400, 'Select up to 200 listings.');
  const result = sandbox.transaction(() => {
    let updated = 0;
    let skipped = 0;
    for (const id of ids) {
      const thread = q.thread.get(id);
      if (!thread || thread.user_id !== req.user.id || !thread.is_market || !thread.listing_type ||
          thread.status === 'sold' || sandbox.lockListing(id)) {
        skipped++;
        continue;
      }
      if (thread.status !== status) {
        setListingStatus(thread, status, req.user.id);
        updated++;
      }
    }
    return { updated, skipped };
  });
  flash(res, `${result.updated} updated. ${result.skipped} unavailable for bulk changes.`);
  res.redirect('/my/listings');
});

app.get('/upgrades', requireSandbox, (req, res) => {
  const membership = req.user ? memberships.current(req.user.id) : null;
  res.render('upgrades', { title: 'Membership upgrades', plans: memberships.plans, membership });
});

app.post('/upgrades', requireSandbox, requireLogin, (req, res) => {
  const plan = String(req.body.plan || '');
  if (!Object.hasOwn(memberships.plans, plan)) return fail(res, 400, 'Choose a membership tier.');
  if (plan !== 'free') return res.redirect(303, '/upgrades/checkout/' + plan);
  memberships.choose(req.user.id, 'free');
  flash(res, 'Switched to Free.');
  res.redirect('/upgrades');
});

function requirePaidPlan(req, res, next) {
  const key = req.params.plan;
  if (key === 'free' || !Object.hasOwn(memberships.plans, key)) return fail(res, 404, 'Membership tier not found.');
  next();
}

app.get('/upgrades/checkout/:plan', requireSandbox, requireLogin, requirePaidPlan, (req, res) => {
  const plan = memberships.plans[req.params.plan];
  const membership = memberships.current(req.user.id);
  if (membership.plan === req.params.plan) return res.redirect('/upgrades');
  res.render('upgrade_checkout', {
    title: plan.name + ' checkout', plan, planKey: req.params.plan, currentPlan: memberships.plans[membership.plan],
  });
});

app.post('/upgrades/checkout/:plan', requireSandbox, requireLogin, requirePaidPlan, (req, res) => {
  memberships.choose(req.user.id, req.params.plan);
  flash(res, memberships.plans[req.params.plan].name + ' activated in the sandbox.');
  res.redirect(303, '/upgrades');
});

app.post('/upgrades/headline', requireSandbox, requireLogin, (req, res) => {
  if (!memberships.setHeadline(req.user.id, clean(req.body.headline, 72))) return fail(res, 403, 'A Plus or Pro membership is required.');
  flash(res, 'Profile headline saved.');
  res.redirect('/upgrades');
});

app.get('/my/listings/export', requireSandbox, requireLogin, (req, res) => {
  if (memberships.current(req.user.id).plan !== 'pro') return fail(res, 403, 'A Pro membership is required.');
  const rows = db.prepare(`SELECT handle, title, listing_type, status, price_cents, views FROM threads
    WHERE user_id = ? AND listing_type IS NOT NULL AND deleted = 0 ORDER BY id DESC`).all(req.user.id);
  const columns = ['handle', 'title', 'listing_type', 'status', 'price_cents', 'views'];
  const csvCell = (value) => {
    let text = String(value ?? '');
    if (/^[\s\u0000-\u001f]*[=+\-@]|^[\t\r\n]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  const csv = [columns.join(','), ...rows.map((row) => columns.map((key) => csvCell(row[key])).join(','))].join('\r\n');
  res.set('Cache-Control', 'private, no-store').attachment('fincen-listings.csv').send(csv);
});

/* ---------- errors ---------- */
app.use((req, res) => fail(res, 404, 'Page not found.'));
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  fail(res, err.status === 413 ? 413 : 500, err.status === 413 ? 'That is too long.' : 'Something went wrong on our end.');
});

app.listen({ port: PORT, ...(sandbox.enabled ? { host: '127.0.0.1' } : {}) },
  () => console.log(`${SITE} running at http://localhost:${PORT}`));
