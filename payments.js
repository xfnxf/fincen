// Membership payments through NOWPayments (crypto). Only memberships are sold this way;
// username deals stay between members.
//
// Set NOWPAYMENTS_API_KEY and NOWPAYMENTS_IPN_SECRET to switch it on. NOWPAYMENTS_API_URL
// can point at their sandbox (https://api-sandbox.nowpayments.io/v1) while testing.
const crypto = require('crypto');

const API = (process.env.NOWPAYMENTS_API_URL || 'https://api.nowpayments.io/v1').replace(/\/+$/, '');
const KEY = process.env.NOWPAYMENTS_API_KEY || '';
const SECRET = process.env.NOWPAYMENTS_IPN_SECRET || '';
const enabled = !!(KEY && SECRET);
const IPN_PATH = '/payments/nowpayments/ipn';

async function call(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { 'x-api-key': KEY, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok || !data) throw new Error(`NOWPayments ${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  return data;
}

// Creates a hosted invoice page the buyer pays on. Returns { id, url }.
async function createInvoice({ orderRef, cents, description, siteUrl, returnPath }) {
  const data = await call('POST', '/invoice', {
    price_amount: cents / 100,
    price_currency: 'usd',
    order_id: orderRef,
    order_description: description,
    ipn_callback_url: siteUrl + IPN_PATH,
    success_url: siteUrl + returnPath,
    cancel_url: siteUrl + returnPath,
  });
  if (!data.id || !/^https:\/\//.test(String(data.invoice_url || ''))) throw new Error('NOWPayments returned no invoice link.');
  return { id: String(data.id), url: data.invoice_url };
}

const getPayment = (paymentId) => call('GET', '/payment/' + encodeURIComponent(paymentId));

// NOWPayments signs the callback body: keys sorted at every level, JSON-encoded, HMAC-SHA512 with the IPN secret.
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => { out[key] = sortKeys(value[key]); return out; }, {});
  }
  return value;
}
function sign(body, secret = SECRET) {
  return crypto.createHmac('sha512', secret).update(JSON.stringify(sortKeys(body))).digest('hex');
}
function validSignature(body, signature) {
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(String(signature || '').toLowerCase());
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

module.exports = { enabled, IPN_PATH, createInvoice, getPayment, validSignature, sign };
