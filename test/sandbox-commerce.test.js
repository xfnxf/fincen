const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const test = require('node:test');

async function startForum(dataDir, production = false) {
  const probe = net.createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), NODE_ENV: production ? 'production' : 'development', CHECKOUT_SANDBOX: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  server.stderr.on('data', (data) => { errors += data; });
  await Promise.race([
    once(server.stdout, 'data'),
    once(server, 'exit').then(() => { throw new Error(errors || 'Forum exited before starting.'); }),
  ]);
  return {
    origin: 'http://127.0.0.1:' + port,
    async stop() {
      if (server.exitCode !== null || server.signalCode !== null) return;
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    },
  };
}

test('sandbox checkout and membership upgrades through the forum', { timeout: 20_000 }, async (t) => {
  const temp = fs.realpathSync(os.tmpdir());
  const dataDir = fs.mkdtempSync(path.join(temp, 'fincen-commerce-test-'));
  process.env.DATA_DIR = dataDir;
  const db = require('../db');
  let forum;
  let production;
  try {
    const now = Date.now();
    const insertUser = db.prepare('INSERT INTO users (username, role, pass_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?)');
    const insertSession = db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)');
    function member(name, role = 'member') {
      const id = insertUser.run(name, role, 'fixture', now, now).lastInsertRowid;
      const sid = randomBytes(32).toString('hex');
      const csrf = randomBytes(32).toString('hex');
      insertSession.run(sid, id, now + 600_000);
      return { id, name, csrf, cookie: 'sid=' + sid + '; csrf=' + csrf };
    }
    const staff = member('test_staff', 'mod');
    const seller = member('test_seller');
    const buyer = member('test_buyer');
    const competitor = member('test_competitor');
    function listing(handle, platform = 'telegram', price = 1900) {
      return db.prepare(`INSERT INTO threads (forum_id, user_id, title, body, created_at, last_post_at, listing_type, handle, price_cents)
        SELECT id, ?, ?, 'Test fixture', ?, ?, 'sell', ?, ? FROM forums WHERE slug = ?`)
        .run(seller.id, 'Test listing ' + handle, now, now, handle, price, platform).lastInsertRowid;
    }
    const first = listing('test_first');
    const second = listing('test_second');
    const unsupported = listing('test_discord', 'discord');
    const expiring = listing('test_expire');
    forum = await startForum(dataDir);

    function request(route, user, form) {
      return fetch(forum.origin + route, {
        method: form ? 'POST' : 'GET', redirect: 'manual', signal: AbortSignal.timeout(5000),
        headers: { cookie: user.cookie },
        body: form ? new URLSearchParams({ _csrf: user.csrf, ...form }) : undefined,
      });
    }
    async function html(route, user) {
      const response = await request(route, user);
      assert.equal(response.status, 200, await response.clone().text().then((body) => body.slice(-300)));
      return response.text();
    }
    const buy = (id, user) => request('/t/' + id + '/checkout', user, {});
    const approve = (id, user = staff) => request('/t/' + id + '/checkout/approval', user, { enabled: '1' });
    const act = (order, user, action, detail = '') => request(order, user, { action, detail });

    await t.test('reserves once, verifies transfer before payout, and blocks duplicate purchases', async () => {
      assert.equal((await buy(first, buyer)).status, 409);
      assert.equal((await approve(first, buyer)).status, 403);
      assert.equal((await approve(unsupported)).status, 400);
      assert.equal((await approve(first)).status, 302);
      assert.match(await html('/t/' + first, buyer), /Buy now \(test\)/);
      assert.equal((await buy(first, seller)).status, 409);
      const attempts = await Promise.all([buy(first, buyer), buy(first, competitor)]);
      assert.deepEqual(attempts.map((result) => result.status).sort(), [302, 409]);
      const winner = attempts[0].status === 302 ? buyer : competitor;
      const loser = winner === buyer ? competitor : buyer;
      const order = attempts.find((response) => response.status === 302).headers.get('location');
      const checkout = await html(order, winner);
      assert.match(checkout, /Listing checkout/);
      assert.match(checkout, /Confirm test purchase/);
      assert.match(checkout, /\$19/);
      assert.equal((await buy(first, winner)).headers.get('location'), order);
      assert.equal((await request(order, loser)).status, 404);
      assert.equal((await act(order, staff, 'release')).status, 409);
      assert.equal((await act(order, winner, 'pay')).status, 302);
      assert.equal((await act(order, winner, 'pay')).status, 409);
      assert.match(await html('/orders', seller), /Your turn · Submit the transfer reference/);
      assert.match(await html('/notifications', seller), /Test payment received for/);
      assert.equal((await request('/t/' + first + '/status', seller, { status: 'closed' })).status, 409);
      assert.equal((await act(order, seller, 'deliver')).status, 400);
      assert.equal((await act(order, seller, 'deliver', 'sample-transfer-1')).status, 302);
      assert.equal((await act(order, seller, 'release')).status, 403);
      assert.match(await html(order, staff), /sample-transfer-1/);
      assert.equal((await act(order, staff, 'release')).status, 302);
      const completed = await html(order, winner);
      assert.match(completed, /Test payout released/);
      assert.match(completed, /Order timeline[\s\S]*Reserved[\s\S]*Test payment received[\s\S]*Transfer submitted[\s\S]*Test payout released/);
      assert.equal((await buy(first, loser)).status, 409);
    });

    await t.test('allows a refund on failed delivery and frees cancelled or expired reservations', async () => {
      assert.equal((await approve(second)).status, 302);
      const order = (await buy(second, buyer)).headers.get('location');
      assert.equal((await act(order, buyer, 'pay')).status, 302);
      assert.equal((await act(order, buyer, 'dispute', 'No transfer arrived.')).status, 302);
      assert.match(await html('/orders?review=1&disputes=1', staff), /@test_second/);
      assert.match(await html('/notifications', staff), /Disputed for/);
      assert.equal((await request(order + '/dispute/replies', competitor, { body: 'Unauthorized reply' })).status, 404);
      assert.equal((await request(order + '/dispute/replies', seller, { body: 'Sample evidence for the ticket.' })).status, 302);
      assert.match(await html(order, buyer), /Dispute ticket[\s\S]*No transfer arrived.[\s\S]*Sample evidence for the ticket./);
      assert.equal((await act(order, staff, 'release')).status, 409);
      assert.equal((await act(order, staff, 'refund')).status, 302);
      assert.match(await html(order, buyer), /Test payment refunded/);
      assert.equal((await request(order + '/dispute/replies', buyer, { body: 'Too late' })).status, 409);
      assert.doesNotMatch(await html('/orders?review=1&disputes=1', staff), /@test_second/);
      const replacement = await buy(second, competitor);
      assert.equal(replacement.status, 302);
      assert.equal((await act(replacement.headers.get('location'), competitor, 'cancel')).status, 302);
      assert.equal((await buy(second, buyer)).status, 302);
      assert.equal((await approve(expiring)).status, 302);
      const expired = (await buy(expiring, buyer)).headers.get('location');
      db.prepare('UPDATE sandbox_orders SET expires_at = ? WHERE thread_id = ?').run(now - 1, expiring);
      assert.equal((await act(expired, buyer, 'pay')).status, 409);
      assert.equal((await buy(expiring, competitor)).status, 302);
    });

    await t.test('enforces upgrade perks and hides sandbox commerce in production', async () => {
      const guest = { cookie: '' };
      assert.match(await html('/upgrades', guest), /Choose Pro/);
      const guestCheckout = await request('/upgrades/checkout/plus', guest);
      assert.match(guestCheckout.headers.get('location'), /^\/login\?next=/);
      assert.match(await html('/u/' + seller.name, seller), /Upgrade membership/);
      assert.equal((await request('/my/listings/export', seller)).status, 403);
      assert.match(await html('/upgrades', seller), /\$12 \/ month/);
      const choosePlus = await request('/upgrades', seller, { plan: 'plus' });
      assert.equal(choosePlus.headers.get('location'), '/upgrades/checkout/plus');
      const plusCheckout = await html('/upgrades/checkout/plus', seller);
      assert.match(plusCheckout, /Plus membership/);
      assert.match(plusCheckout, /Confirm test purchase/);
      assert.equal((await request('/upgrades/headline', seller, { headline: 'Before checkout' })).status, 403);
      assert.equal((await request('/upgrades/checkout/plus', seller, { _csrf: 'invalid' })).status, 403);
      assert.equal((await request('/upgrades/checkout/plus', seller, {})).status, 303);
      assert.equal((await request('/upgrades/headline', seller, { headline: 'Test seller headline' })).status, 302);
      assert.match(await html('/u/' + seller.name, buyer), /Test seller headline/);
      assert.equal((await request('/my/listings/export', seller)).status, 403);
      assert.equal((await request('/upgrades/checkout/unknown', seller)).status, 404);
      assert.match(await html('/upgrades/checkout/pro', seller), /Pro membership/);
      assert.equal((await request('/upgrades/checkout/pro', seller, {})).status, 303);
      assert.match(await html('/my/listings', seller), /Seller dashboard/);
      assert.equal((await request('/my/listings/bulk', buyer, { listing: unsupported, status: 'closed' })).status, 403);
      assert.equal((await request('/my/listings/bulk', seller, { listing: unsupported, status: 'closed' })).status, 302);
      assert.equal(db.prepare('SELECT status FROM threads WHERE id = ?').get(unsupported).status, 'closed');
      assert.equal((await request('/my/listings/bulk', seller, { listing: unsupported, status: 'open' })).status, 302);
      assert.equal((await request('/saved/searches', buyer)).status, 403);
      assert.equal((await request('/upgrades/checkout/plus', buyer, {})).status, 303);
      assert.match(await html('/market?platform=discord&max=20', buyer), /Save these filters/);
      assert.equal((await request('/saved/searches', buyer, { platform: 'discord', max: '20', name: 'Discord under $20' })).status, 302);
      assert.match(await html('/saved/searches', buyer), /platform=discord[\s\S]*Discord under \$20/);
      await request('/t/' + unsupported + '/save', buyer, {});
      await request('/t/' + unsupported + '/save', competitor, {});
      assert.equal((await request('/t/' + unsupported + '/edit', seller, {
        title: 'Test Discord listing', body: 'Test fixture listing', listing_type: 'sell', handle: 'test_discord', price: '12',
      })).status, 302);
      assert.match(await html('/notifications', buyer), /lowered the price of/);
      assert.doesNotMatch(await html('/notifications', competitor), /lowered the price of/);
      const csv = await request('/my/listings/export', seller);
      assert.equal(csv.status, 200);
      assert.match(await csv.text(), /test_first/);
      assert.equal((await request('/upgrades', seller, { plan: 'free' })).status, 302);
      assert.doesNotMatch(await html('/u/' + seller.name, buyer), /Test seller headline/);
      assert.equal((await request('/my/listings/export', seller)).status, 403);
      production = await startForum(dataDir, true);
      const response = await fetch(production.origin + '/upgrades', { headers: { cookie: seller.cookie }, redirect: 'manual' });
      assert.equal(response.status, 404);
    });
  } finally {
    await production?.stop();
    await forum?.stop();
    db.close();
    if (path.dirname(fs.realpathSync(dataDir)) === temp && path.basename(dataDir).startsWith('fincen-commerce-test-')) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }
});
