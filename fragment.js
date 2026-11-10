const db = require('./db');

const ORIGIN = 'https://fragment.com';
const AGENT = 'Mozilla/5.0 (compatible; fincen-price-reference/1.0)';
const HANDLE_RE = /^[a-z0-9_]{4,32}$/;
const ACTIVE_STATUSES = new Set(['For sale', 'Available', 'On auction']);

function parseListings(html, defaultStatus = '') {
  const listings = [];
  for (const [, row] of html.matchAll(/<tr\b[^>]*class="[^"]*\btm-row-selectable\b[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const handle = /class="table-cell-value tm-value">@([a-z0-9_]{4,32})</i.exec(row)?.[1].toLowerCase();
    if (!handle) continue;
    const label = /class="table-cell-status-thin[^"]*">([^<]+)</.exec(row)?.[1].trim();
    const status = !label || label === 'Resale' ? defaultStatus : label;
    const amount = /\bicon-ton">([\d,.]+)</.exec(row)?.[1];
    const value = Number(amount?.replaceAll(',', ''));
    const price = Number.isFinite(value) && value > 0 ? value : null;
    const kind = status === 'Available' || status === 'On auction' ? 'minimum_bid' : 'sale';
    const date = Date.parse(/<time\b[^>]*\bdatetime="([^"]+)"/.exec(row)?.[1]) || null;
    listings.push({ handle, status: status || 'Unknown', price, kind, date, url: listingUrl(handle) });
  }
  return listings;
}

function canBroker(listing, now = Date.now()) {
  return ACTIVE_STATUSES.has(listing.status) && listing.price !== null && (!listing.date || listing.date > now);
}

const upsert = db.prepare(`INSERT INTO external_listings (source, handle, price_ton, price_kind, url, ends_at, fetched_at)
  VALUES ('fragment', ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source, handle) DO UPDATE SET
    price_ton = excluded.price_ton, price_kind = excluded.price_kind, url = excluded.url,
    ends_at = excluded.ends_at, fetched_at = excluded.fetched_at`);

function listingUrl(handle) {
  return ORIGIN + '/username/' + handle;
}

function saveListing(listing, checkedAt) {
  upsert.run(listing.handle, listing.price, listing.kind, listing.url, listing.date, checkedAt);
}

function searchUrl({ query = '', sort = '', filter = '' }) {
  const url = new URL('/', ORIGIN);
  if (query) url.searchParams.set('query', query);
  if (sort) url.searchParams.set('sort', sort);
  if (filter) url.searchParams.set('filter', filter);
  return url;
}

async function fetchResults(options) {
  const { query = '', sort = '', filter = '', offset } = options;
  const url = searchUrl(options);
  const signal = AbortSignal.timeout(4500);
  const headers = { 'user-agent': AGENT };
  const response = await fetch(url, { headers, redirect: 'error', signal });
  if (!response.ok) throw new Error('Fragment returned HTTP ' + response.status);
  let html = await response.text();
  if (!html.includes('js-search-results')) throw new Error('Unexpected Fragment search response');

  if (offset) {
    // Fragment's public search sends an anonymous session with its load-more request.
    const init = /ajInit\((\{[^\n]+\})\);/.exec(html)?.[1];
    const api = new URL(JSON.parse(init || '{}').apiUrl || '/', ORIGIN);
    const session = response.headers.getSetCookie().find((cookie) => cookie.startsWith('stel_ssid='));
    if (api.origin !== ORIGIN || api.pathname !== '/api' || !session) throw new Error('Fragment continuation is unavailable');
    const more = await fetch(api, {
      method: 'POST', signal, redirect: 'error',
      headers: { ...headers, 'x-requested-with': 'XMLHttpRequest', origin: ORIGIN, referer: url.href, cookie: session.split(';', 1)[0] },
      body: new URLSearchParams({ method: 'searchAuctions', type: 'usernames', query, sort, filter, offset_id: offset }),
    });
    if (!more.ok) throw new Error('Fragment returned HTTP ' + more.status);
    const data = await more.json();
    if (!data.ok || typeof data.body !== 'string' || typeof data.foot !== 'string') throw new Error('Unexpected Fragment continuation');
    html = data.body + data.foot;
  }

  const defaultStatus = query ? '' : filter === 'sold' ? 'Sold' : filter === 'sale' ? 'For sale' : 'On auction';
  return {
    listings: parseListings(html, defaultStatus),
    nextOffset: /data-next-offset="(\d+)"/.exec(html)?.[1] || '',
  };
}

const recentSearches = new Map();
let pendingSearches = 0;

async function searchListings(options) {
  const key = searchUrl(options).href + '#' + (options.offset || '');
  const cached = recentSearches.get(key);
  if (cached?.until > Date.now()) return cached.request;
  if (pendingSearches >= 4) throw new Error('Fragment lookup capacity reached');
  pendingSearches++;
  const request = fetchResults(options).finally(() => { pendingSearches--; });
  recentSearches.delete(key);
  if (recentSearches.size >= 64) recentSearches.delete(recentSearches.keys().next().value);
  recentSearches.set(key, { until: Date.now() + 60_000, request });
  return request;
}

module.exports = { AGENT, HANDLE_RE, ORIGIN, canBroker, listingUrl, parseListings, saveListing, searchListings, searchUrl };
