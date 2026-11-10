// Real membership payments, run in production mode against a stand-in for the NOWPayments API.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, createHmac } = require('node:crypto');
const test = require('node:test');

const API_KEY = 'test-api-key';
const IPN_SECRET = 'test-ipn-secret';

async function freePort() {
  const probe = net.createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object'
  ? Object.keys(v).sort().reduce((o, k) => { o[k] = sortKeys(v[k]); return o; }, {}) : v);
const sign = (body, secret = IPN_SECRET) => createHmac('sha512', secret).update(JSON.stringify(sortKeys(body))).digest('hex');

test('memberships are sold through NOWPayments and only activate on a verified full payment', { timeout: 30_000 }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fincen-pay-test-'));
  process.env.DATA_DIR = dataDir;
  const db = require('../db');

  // Stand-in provider: records invoices and answers payment lookups from a table the test controls.
  const invoices = [];
  const paymentsById = new Map();
  let lookupsFail = false;
  const provider = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.headers['x-api-key'] !== API_KEY) return send(401, { message: 'bad key' });
      if (req.method === 'POST' && req.url === '/invoice') {
        const body = JSON.parse(raw);
        invoices.push(body);
        return send(200, { id: 'inv' + invoices.length, invoice_url: 'https://nowpayments.example/pay/inv' + invoices.length });
      }
      const m = /^\/payment\/(.+)$/.exec(req.url);
      if (req.method === 'GET' && m) {
        if (lookupsFail) return send(500, { message: 'down' });
        const p = paymentsById.get(decodeURIComponent(m[1]));
        return p ? send(200, p) : send(404, { message: 'not found' });
      }
      send(404, { message: 'no route' });
    });
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const providerUrl = 'http://127.0.0.1:' + provider.address().port;

  const port = await freePort();
  const origin = 'http://127.0.0.1:' + port;
  const now = Date.now();
  function member(name, role = 'member') {
    const id = db.prepare('INSERT INTO users (username, role, pass_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?)')
      .run(name, role, 'fixture', now, now).lastInsertRowid;
    const sid = randomBytes(32).toString('hex');
    const csrf = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(sid, id, now + 600_000);
    return { id, name, csrf, cookie: 'sid=' + sid + '; csrf=' + csrf };
  }
  const buyer = member('pay_buyer');
  const other = member('pay_other');
  const admin = member('pay_admin', 'admin');

  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), NODE_ENV: 'production', CHECKOUT_SANDBOX: '',
      SITE_URL: 'https://fincen.example', NOWPAYMENTS_API_KEY: API_KEY, NOWPAYMENTS_IPN_SECRET: IPN_SECRET, NOWPAYMENTS_API_URL: providerUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  server.stderr.on('data', (d) => { errors += d; });
  await Promise.race([once(server.stdout, 'data'), once(server, 'exit').then(() => { throw new Error(errors || 'server exited'); })]);

  const request = (route, user, form) => fetch(origin + route, {
    method: form ? 'POST' : 'GET', redirect: 'manual', signal: AbortSignal.timeout(5000),
    headers: user ? { cookie: user.cookie } : {},
    body: form ? new URLSearchParams({ _csrf: user.csrf, ...form }) : undefined,
  });
  const ipn = (body, signature = sign(body)) => fetch(origin + '/payments/nowpayments/ipn', {
    method: 'POST', signal: AbortSignal.timeout(5000),
    headers: { 'content-type': 'application/json', ...(signature ? { 'x-nowpayments-sig': signature } : {}) },
    body: JSON.stringify(body),
  });
  const planOf = (user) => db.prepare('SELECT plan FROM sandbox_memberships WHERE user_id = ?').get(user.id)?.plan || 'free';
  const orderOf = (ref) => db.prepare('SELECT * FROM membership_orders WHERE token = ?').get(ref);
  async function startCheckout(user, plan) {
    const res = await request('/upgrades/checkout/' + plan, user, {});
    assert.equal(res.status, 303, await res.clone().text().then((b) => b.slice(-300)));
    return res.headers.get('location').split('/').pop();
  }

  try {
    await t.test('checkout creates an invoice for the right amount and does not activate anything', async () => {
      assert.match(await (await request('/upgrades', buyer)).text(), /NOWPayments/);
      assert.equal((await request('/orders', buyer)).status, 404, 'username checkout stays off in production');
      const ref = await startCheckout(buyer, 'plus');
      assert.equal(invoices.length, 1);
      assert.deepEqual(
        { amount: invoices[0].price_amount, currency: invoices[0].price_currency, order: invoices[0].order_id, ipn: invoices[0].ipn_callback_url },
        { amount: 5, currency: 'usd', order: ref, ipn: 'https://fincen.example/payments/nowpayments/ipn' });
      assert.equal(planOf(buyer), 'free');
      const page = await (await request('/upgrades/orders/' + ref, buyer)).text();
      assert.match(page, /https:\/\/nowpayments\.example\/pay\/inv1/);
      assert.equal((await request('/upgrades/orders/' + ref, other)).status, 404, 'another member cannot see the payment');
      assert.equal((await request('/upgrades', buyer, { plan: 'free' })).status, 400, 'no free reset when payments are real');
    });

    await t.test('rejects callbacks that are unsigned, wrongly signed, or not backed by the provider', async () => {
      const ref = await startCheckout(buyer, 'plus');
      const body = { payment_id: 501, payment_status: 'finished', order_id: ref, price_amount: 5, price_currency: 'usd' };
      assert.equal((await ipn(body, '')).status, 401);
      assert.equal((await ipn(body, sign(body, 'wrong-secret'))).status, 401);
      assert.equal(planOf(buyer), 'free');
      // Correctly signed, but the provider has no such payment: retried later, nothing activated.
      assert.equal((await ipn(body)).status, 502);
      // Signed "finished", but the provider says it is still confirming.
      paymentsById.set('501', { payment_id: 501, payment_status: 'confirming', order_id: ref, price_amount: 5, price_currency: 'usd', pay_currency: 'ton' });
      assert.equal((await ipn(body)).status, 200);
      assert.equal(planOf(buyer), 'free');
      assert.equal(orderOf(ref).status, 'pending');
      // The provider lookup belongs to a different order.
      paymentsById.set('502', { payment_id: 502, payment_status: 'finished', order_id: 'someone-else', price_amount: 5, price_currency: 'usd' });
      assert.equal((await ipn({ ...body, payment_id: 502 })).status, 200);
      assert.equal(planOf(buyer), 'free');
      lookupsFail = true;
      assert.equal((await ipn(body)).status, 502);
      lookupsFail = false;
    });

    await t.test('underpayment and wrong price never activate; a full verified payment does, once', async () => {
      const ref = await startCheckout(buyer, 'pro');
      const body = { payment_id: 601, payment_status: 'partially_paid', order_id: ref, price_amount: 12, price_currency: 'usd' };
      paymentsById.set('601', { payment_id: 601, payment_status: 'partially_paid', order_id: ref, price_amount: 12, price_currency: 'usd', pay_currency: 'ton' });
      assert.equal((await ipn(body)).status, 200);
      assert.equal(orderOf(ref).status, 'partial');
      assert.equal(planOf(buyer), 'free');
      assert.match(await (await request('/upgrades/orders/' + ref, buyer)).text(), /Part of the payment arrived/);

      // "finished" for a cheaper price than the tier costs.
      paymentsById.set('601', { payment_id: 601, payment_status: 'finished', order_id: ref, price_amount: 5, price_currency: 'usd', pay_currency: 'ton' });
      assert.equal((await ipn({ ...body, payment_status: 'finished' })).status, 200);
      assert.equal(planOf(buyer), 'free');

      paymentsById.set('601', { payment_id: 601, payment_status: 'finished', order_id: ref, price_amount: 12, price_currency: 'usd', pay_currency: 'ton' });
      assert.equal((await ipn({ ...body, payment_status: 'finished' })).status, 200);
      assert.equal(planOf(buyer), 'pro');
      assert.equal(orderOf(ref).status, 'paid');
      assert.equal(orderOf(ref).pay_currency, 'ton');

      // A later "refunded" or repeat callback does not undo or redo a paid order.
      paymentsById.set('601', { payment_id: 601, payment_status: 'failed', order_id: ref, price_amount: 12, price_currency: 'usd' });
      assert.equal((await ipn({ ...body, payment_status: 'failed' })).status, 200);
      assert.equal(orderOf(ref).status, 'paid');
      assert.equal(planOf(buyer), 'pro');

      assert.match(await (await request('/upgrades/orders/' + ref, buyer)).text(), /Aurum is active/);
      assert.equal((await request('/my/listings/export', buyer)).status, 200, 'Aurum perk unlocked');
      assert.equal((await request('/my/listings/export', other)).status, 403);
      assert.equal((await request('/upgrades/checkout/plus', buyer, {})).headers.get('location'), '/upgrades', 'cannot buy a lower tier');
    });

    await t.test('only admins see payments and can activate one by hand', async () => {
      const ref = await startCheckout(other, 'plus');
      assert.equal((await request('/mod/memberships', buyer)).status, 403);
      assert.match(await (await request('/mod/memberships', admin)).text(), /pay_other/);
      const id = orderOf(ref).id;
      assert.equal((await request('/mod/memberships/' + id + '/activate', buyer, {})).status, 403);
      assert.equal((await request('/mod/memberships/' + id + '/activate', admin, {})).status, 302);
      assert.equal(planOf(other), 'plus');
    });

    await t.test('tiers decide who can post listings, how many, and how often they bump', async () => {
      const free = member('pay_free');
      const top = member('pay_top');
      db.prepare("INSERT INTO sandbox_memberships (user_id, plan) VALUES (?, 'elite')").run(top.id);
      const fixture = (user, handle) => db.prepare(`INSERT INTO threads
        (forum_id, user_id, title, body, created_at, last_post_at, listing_type, handle, price_cents)
        SELECT id, ?, ?, 'Test fixture', ?, ?, 'sell', ?, 2000 FROM forums WHERE slug = 'discord'`)
        .run(user.id, 'Fixture ' + handle, now, now, handle).lastInsertRowid;
      const post = (user, slug, handle) => request('/f/' + slug + '/new', user, slug === 'general'
        ? { title: 'Hello there', body: 'A normal discussion post.' }
        : { listing_type: 'sell', handle, price: '20', title: 'Test listing', body: 'A listing used by the tests.' });

      // Free: no listings, but the rest of the forum still works.
      const refused = await post(free, 'discord', 'freename');
      assert.equal(refused.status, 403);
      assert.match(await refused.text(), /Argent membership needed/);
      assert.equal((await request('/f/discord/new', free)).status, 403);
      assert.equal((await post(free, 'general')).status, 302);
      assert.match(await (await request('/sell', free)).text(), /Argent membership needed/);

      // Argent (5 open listings): the fifth goes through, the sixth does not.
      const held = [1, 2, 3, 4].map((n) => fixture(other, 'argent' + n));
      assert.equal((await post(other, 'discord', 'argent5')).status, 302);
      const sixth = await post(other, 'discord', 'argent6');
      assert.equal(sixth.status, 403);
      assert.match(await sixth.text(), /Listing limit reached/);
      // Closing one frees a slot, and reopening past the limit is refused.
      assert.equal((await request('/t/' + held[0] + '/status', other, { status: 'closed' })).status, 302);
      fixture(other, 'argent7');
      assert.equal((await request('/t/' + held[0] + '/status', other, { status: 'open' })).status, 403);

      // Staff are not limited by tiers.
      assert.equal((await post(admin, 'discord', 'staffname')).status, 302);

      // Bump timers: Aurum every 12 hours, Argent every 24.
      const thirteenHoursAgo = Date.now() - 13 * 3600 * 1000;
      const aurumListing = fixture(buyer, 'aurumbump');
      db.prepare('UPDATE threads SET bumped_at = ? WHERE id IN (?, ?)').run(thirteenHoursAgo, aurumListing, held[1]);
      assert.equal((await request('/t/' + aurumListing + '/bump', buyer, {})).status, 302);
      assert.equal((await request('/t/' + held[1] + '/bump', other, {})).status, 429);

      // Imperium listings are highlighted; nobody else's are.
      fixture(top, 'imperiumname');
      const market = await (await request('/market', free)).text();
      assert.equal((market.match(/chip gold/g) || []).length, 1);
      assert.match(market, /class="[^"]*featured[^"]*">[\s\S]*?@imperiumname/);
    });
  } finally {
    const exited = once(server, 'exit');
    server.kill();
    await exited;
    provider.close();
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
