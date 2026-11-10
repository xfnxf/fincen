# Fincen Rust migration — next phase

The local preview serves the homepage and marketplace through Axum, Askama, and PostgreSQL. It shares the Hermes stylesheet, fonts, and theme toggle with the existing forum. Express continues to serve the full forum on port 3001. The preview on port 3002 uses a separate PostgreSQL snapshot, so later changes made on the Express site will not appear there automatically.

## Run the preview

From `rust/`, set `DATABASE_URL` to a fresh local PostgreSQL database and run these commands. SQLx uses the checked metadata in `.sqlx` when `SQLX_OFFLINE=true` is set for the build. Keep `DATABASE_URL` set at runtime.

```text
cargo run --locked -- --migrate-only
npm ci
node import-sqlite.mjs ../data/forum.db
cargo run --locked
```

Set `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, and PostgreSQL credentials for the import command. The import reads SQLite in a snapshot transaction, refuses a populated destination, and checks row counts before committing. It transfers persistent records and preserves their IDs. Sessions and password reset tokens are excluded. Node is used for the importer only.

The preview binds to loopback. Routes other than the homepage, marketplace, health check, and static assets hand off GET and HEAD requests to the existing forum. Account and write flows, Redis, search indexing, frontend tooling, WebSockets, and deployment remain later work.

## Target architecture

| Area | Planned choice | Boundary |
| --- | --- | --- |
| HTTP | Axum 0.8+ / Tokio / Tower | Routing, auth, request limits, tracing, static files |
| HTML | Askama | Server-rendered pages and HTMX fragments |
| Database | PostgreSQL + SQLx | Durable forum, listing, bid, moderation, and job state |
| Sessions / limits | Redis | Expiring sessions and atomic rate limits |
| Jobs | Redis-backed worker | Retryable jobs; durable outcomes recorded in PostgreSQL |
| Search | Meilisearch | Derived public search index; database remains authoritative |
| Interaction | HTMX + Alpine.js | Forms, pagination, dropdowns, small state |
| Complex widgets | React islands | Auction bidding, seller dashboard, moderation where needed |
| Build | Vite + Bun | Build-time only; serve compiled assets from Rust |
| Styling | Tailwind + explicit design tokens | Port this design, with DaisyUI only where its component behavior is useful |
| Realtime | Axum WebSockets | Auction updates and authenticated notifications |
| Hosting | Njalla VPS + Caddy + systemd | Native services; no Docker requirement |

Do not assume benchmark numbers or idle-memory figures apply to this forum. Measure representative requests, p95 latency, memory under load, database pool cost, and total VPS memory including PostgreSQL, Redis, and Meilisearch. Askama compiles templates, but rendering still performs runtime work. A fully static executable depends on target and native dependencies; verify the release artifact rather than promise it in advance.

## Preserve existing behavior

`MIGRATION_ROUTES.csv` inventories the current routes. Port the following groups and their authorization rules before switching traffic:

1. Registration/login/logout, password reset/email, sessions, CSRF, bans, profile settings.
2. Forum index, thread/reply creation and editing, pagination, pin/lock/delete, reports and role checks.
3. Market filtering, buy/sell listings, status transitions, bump limits, saved listings, seller pages.
4. Member profiles, reputation/vouches, direct messages, notifications, staff pages.
5. Fragment reference listings and broker requests; preserve their external-source labeling.

The current project has no native auction bid engine. Auctions are a new feature after parity: specify auction states, bid increments, seller permissions, reserve behavior, close rules, and notification semantics before implementation. Do not infer these from external Fragment listing data.

## Implementation sequence

1. Install Rust and local PostgreSQL/Redis for development. Pin dependency versions and commit lockfiles. Create Axum routing modules and Askama base/partial templates reproducing the current design.
2. Convert SQLite schema to SQL migrations. Preserve IDs, relationships, money as integer minor units, and time semantics. Explicitly handle SQLite's case-insensitive usernames, boolean integers, timestamps, foreign keys, and PostgreSQL sequence resets.
3. Export a SQLite online backup, import into a separate PostgreSQL database, reconcile table counts and relationships. Keep the original backup unchanged. Existing passwords are Node scrypt `saltHex:keyHex`; verify compatibility with test vectors before reusing accounts or rehashing after login.
4. Port read routes, then authenticated writes with CSRF and authorization tests. Preserve URL paths and query parameters. Use parameterized SQL and transactional multi-row writes.
5. Use SQLx query macros against the migrated development database. Generate checked offline metadata for CI; fail CI when migrations invalidate it. Dynamic query builders need separate integration tests and are not automatically compile-time checked.
6. Move sessions to Redis with TTL, rotate after authentication, revoke on password reset/ban. Use atomic rate-limit operations. Plan a controlled sign-out at cutover rather than blindly copying session secrets.
7. Add Meilisearch indexing through durable outbox events. Never index private messages, hidden/moderated content, or account secrets. Apply visibility filters server-side; handle index lag and deletion propagation.
8. Add HTMX fragments while keeping ordinary form submissions functional. Carry CSRF tokens in mutation requests, retain validation errors, history, focus, and authentication redirects. Add Alpine only for UI state and lazy-load React islands on the pages that use them.
9. Build auction operations with PostgreSQL transactions/row locks and idempotency keys. PostgreSQL stores authoritative end times and bids; Redis timers are wake-up hints, not the only source of closing state. Retry/reconcile after restarts. WebSocket events publish committed results and enforce origin, session, and channel permissions.
10. Reproduce the original Hermes visual identity in Tailwind; do not use the withdrawn redesign tokens. Verify both themes and responsive layouts before replacing the old renderer.

## Verification and cutover

- Route parity, anonymous/member/mod/admin permissions, session expiry, CSRF, and reset-token tests.
- Money/time conversion reconciliation and a restore rehearsal before migration.
- Concurrent bid/close tests, duplicate-job delivery, restart recovery, and notification ordering when auctions are added.
- SQLx schema checks, Askama compilation, frontend build, and database integration tests in CI.
- Keyboard, contrast, mobile, empty-state, validation-error, and signed-in layout checks.
- Benchmark the complete stack with realistic data; the requested performance numbers are not acceptance evidence.
- Provision the Njalla VPS and domain only when supplied. Configure loopback-only application and datastore listeners, Caddy TLS, systemd services, off-host backups and restore testing.
- Cutover: stop writes, take final backup, migrate/reconcile, smoke-test, switch traffic, then monitor. If writes occur in PostgreSQL, rollback requires a data reconciliation plan; do not silently switch back to stale SQLite.

## Reference documentation

- [Axum and Tower integration](https://docs.rs/axum/latest/axum/)
- [Askama compiled templates](https://askama.rs/en/stable/)
- [SQLx query macros and offline metadata](https://docs.rs/sqlx/latest/sqlx/macro.query.html)

Confirm exact versions and APIs again when implementing this next phase.
