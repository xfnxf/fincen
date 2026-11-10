# Putting Fincen online

The site is one Node process with one SQLite file. It needs three things from a host:

1. Node 22.13 or newer (the `Dockerfile` uses Node 24).
2. A disk that survives restarts, for the database. Hosts with no persistent disk will wipe every account on each deploy.
3. HTTPS in front of it. Every host below provides that.

## Before the first deploy

- Use a fresh database for a new site. Sign up for your own account, then run `npm run admin -- YOUR_USERNAME` from the server console with the site's `DATA_DIR` set.
- Pick the public address (`SITE_URL`). Emailed reset links use it.

## Settings

Set these as environment variables on the host. `.env.example` lists the same ones.

| Variable | What it is | Example |
| --- | --- | --- |
| `NODE_ENV` | Must be `production` so cookies are HTTPS-only | `production` |
| `SITE_URL` | Public address, no trailing slash | `https://fincen.example` |
| `DATA_DIR` | Folder for the database, on the persistent disk | `/data` |
| `TRUST_PROXY` | `1` when behind the host's proxy (almost always) | `1` |
| `SMTP_URL` | Mail server for password resets | `smtps://user:pass@smtp.host:465` |
| `MAIL_FROM` | Sender shown on those emails | `Fincen <no-reply@fincen.example>` |
| `PORT` | Only if the host tells you to change it | `3000` |

The `Dockerfile` already sets `NODE_ENV`, `DATA_DIR`, `TRUST_PROXY` and `PORT`.

## Option A: Fly.io

`fly.toml` in this folder is already set up: one small machine, the database volume mounted at `/data`, HTTPS forced, and a health check. Run these from the project folder, in order.

Install the Fly tool and log in (opens a browser; new accounts need a card on file):

```bash
winget install Fly-io.flyctl
```

```bash
fly auth login
```

Create the app and its disk. If the name is taken, pick another and change `app` in `fly.toml` to match:

```bash
fly apps create signet-market
```

```bash
fly volumes create signet_data --size 1 --region iad --yes
```

Set the public address (and mail, once you have a provider), then deploy:

```bash
fly secrets set SITE_URL=https://signet-market.fly.dev
```

```bash
fly deploy --ha=false
```

`--ha=false` keeps it to one machine. SQLite is a single file and cannot be shared between several, so never scale this app above one.

After the first deploy, register your account and grant it administrator access from the server console.

```bash
fly ssh console -C "setpriv --reuid=node --regid=node --init-groups node /app/grant-admin.js YOUR_USERNAME"
```

Later, for mail and your own domain:

```bash
fly secrets set SMTP_URL='smtps://USER:PASS@HOST:465' MAIL_FROM='Fincen <no-reply@YOUR-DOMAIN>'
```

```bash
fly certs add YOUR-DOMAIN
```

Then set `SITE_URL` to the new address the same way. To load the Fragment list on the live site:

```bash
fly ssh console -C "setpriv --reuid=node --regid=node --init-groups node /app/import_fragment.js"
```

## Option B: any server with Docker

```bash
docker build -t signet .
docker run -d --name signet --restart unless-stopped -p 127.0.0.1:3000:3000 -v signet_data:/data --env-file .env signet
```

Put Caddy or nginx in front for HTTPS and forward to `127.0.0.1:3000`. With Caddy the whole config is:

```
fincen.example {
  reverse_proxy 127.0.0.1:3000
}
```

## Email

Any provider that gives SMTP details works (Resend, Postmark, Mailgun, Amazon SES, Brevo). You need a domain you control so the provider can verify the sender address; without that, reset emails land in spam or are refused.

If `SMTP_URL` is empty the site still runs. Reset emails are printed to the server log instead of being sent, which is only useful for testing.

Email is optional for members. An account with no email saved cannot reset its password.

## Backups

Everything is in `DATA_DIR`: `forum.db` plus the `-wal` and `-shm` files next to it. Copy all three together, or run this for a clean single-file copy while the site is up:

```bash
sqlite3 /data/forum.db ".backup '/data/backup.db'"
```

## Fragment names

`node import_fragment.js` refreshes the Fragment list. Run it on the server (inside the container: `docker exec signet node import_fragment.js`), by hand or from a daily scheduled job. It is not run automatically.

## Not covered yet

- Email verification at sign-up. An address is accepted as typed.
- Sign-up bot protection beyond rate limits.
- The in-memory rate limiter resets when the process restarts.

## Membership payments (NOWPayments)

Memberships (Argent, Aurum, Imperium) are sold as one-time crypto payments. Username deals are not handled by the site.

1. Create a NOWPayments account and add the payout wallet you want to be paid into.
2. In their dashboard create an API key and an IPN secret key.
3. Set them on the host. The site must already have the right `SITE_URL`, because NOWPayments calls back to `SITE_URL/payments/nowpayments/ipn`.

```bash
fly secrets set NOWPAYMENTS_API_KEY=YOUR_KEY NOWPAYMENTS_IPN_SECRET=YOUR_IPN_SECRET
```

With both set, the Upgrades pages appear on the live site and the perks (saved searches, price-drop alerts, seller dashboard, bulk changes, CSV export, badges) unlock for paying members. With either one missing, memberships stay hidden.

How a payment is accepted: the callback's signature is checked with the IPN secret, then the payment is looked up again from NOWPayments with the API key, and the tier is only switched on when that lookup says `finished` for the full USD price. Underpayments are marked `partial` and left for an admin at `/mod/memberships`.

Test first with their sandbox by also setting `NOWPAYMENTS_API_URL=https://api-sandbox.nowpayments.io/v1` and sandbox keys, then remove it.
