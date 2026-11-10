// Pulls Telegram usernames that are for sale on fragment.com into the external_listings table.
// These are shown on /fragment as reference only, labelled as Fragment's and linked back there.
// They are never mixed into Fincen's own listings.
//
// Run by hand:  node import_fragment.js
// It makes four requests with a pause between them. Do not run it in a tight loop.

const db = require('./db');
const { AGENT, ORIGIN, parseListings, saveListing } = require('./fragment');

const VIEWS = ['listed', 'price_desc', 'price_asc', 'ending'];
const PAUSE_MS = 2500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const found = new Map();
  for (const sort of VIEWS) {
    const url = `${ORIGIN}/?sort=${sort}&filter=sale`;
    const res = await fetch(url, { headers: { 'user-agent': AGENT }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      console.error(`${url} -> ${res.status}, stopping`);
      break;
    }
    const rows = parseListings(await res.text(), 'For sale').filter((row) => row.status === 'For sale' && row.price !== null);
    for (const r of rows) found.set(r.handle, r);
    console.log(`${sort}: ${rows.length} rows, ${found.size} unique so far`);
    await sleep(PAUSE_MS);
  }
  if (!found.size) {
    console.error('Nothing parsed. Fragment may have changed its page. Existing data left as it was.');
    process.exit(1);
  }

  const now = Date.now();
  db.exec('BEGIN');
  for (const r of found.values()) saveListing(r, now);
  // Drop old reference data, since the browse pages only show a sample.
  const gone = db.prepare("DELETE FROM external_listings WHERE source = 'fragment' AND fetched_at < ?").run(now - 7 * 86400000).changes;
  db.exec('COMMIT');
  console.log(`Saved ${found.size} names, removed ${gone} stale.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
