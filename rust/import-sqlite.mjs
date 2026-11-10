import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';

const tables = [
  'users', 'forums', 'threads', 'posts', 'vouches', 'messages', 'reports',
  'saves', 'external_listings', 'broker_requests', 'broker_replies', 'notifications',
];

async function insertBatch(client, table, columns, rows) {
  if (!rows.length) return;
  const values = rows.map((row, i) => '(' + row.map((_, j) => `$${i * columns.length + j + 1}`).join(', ') + ')');
  await client.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${values.join(', ')}`, rows.flat());
}

async function importSnapshot(source) {
  const db = new DatabaseSync(resolve(source), { readOnly: true });
  const client = new pg.Client({ connectionTimeoutMillis: 5000 });
  const counts = {};
  try {
    db.exec('BEGIN');
    if (db.prepare('PRAGMA foreign_key_check').get()) {
      throw new Error('SQLite snapshot has broken foreign keys.');
    }
    await client.connect();
    await client.query('BEGIN');
    await client.query(`LOCK TABLE ${tables.join(', ')} IN ACCESS EXCLUSIVE MODE`);
    const { rows: [check] } = await client.query('SELECT ' + tables.map((t) => `EXISTS (SELECT 1 FROM ${t})`).join(' OR ') + ' AS occupied');
    if (check.occupied) throw new Error('Destination must be empty.');
    for (const table of tables) {
      // Table names are fixed. Quote discovered column names as SQL identifiers.
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
      if (!columns.length && table === 'broker_replies') {
        counts[table] = 0; // Snapshots made before broker replies were added.
        continue;
      }
      if (!columns.length) throw new Error(`Missing SQLite table ${table}.`);
      const names = columns.map((name) => '"' + name.replaceAll('"', '""') + '"');
      const query = db.prepare(`SELECT ${names.join(', ')} FROM ${table}`);
      query.setReadBigInts(true);
      query.setReturnArrays(true);
      let batch = [];
      let count = 0;
      for (const row of query.iterate()) {
        if (row.some((value) => typeof value === 'string' && value.includes('\0'))) {
          throw new Error(`Table ${table} contains text with a NUL byte.`);
        }
        batch.push(row);
        count++;
        if (batch.length === 100) {
          await insertBatch(client, table, names, batch);
          batch = [];
        }
      }
      await insertBatch(client, table, names, batch);
      const { rows: [imported] } = await client.query(`SELECT count(*) FROM ${table}`);
      if (BigInt(imported.count) !== BigInt(count)) throw new Error(`Row count mismatch in ${table}.`);
      if (columns.includes('id')) {
        await client.query(`DO $$ BEGIN EXECUTE format('ALTER TABLE ${table} ALTER COLUMN id RESTART WITH %s', GREATEST(COALESCE((SELECT max(id) FROM ${table}), 0), 0) + 1); END $$`);
      }
      counts[table] = count;
    }
    await client.query('COMMIT');
    return counts;
  } catch (error) {
    // Do not print database error details that can contain account data.
    throw error.code ? new Error(`PostgreSQL or SQLite rejected the import (${error.code}).`) : error;
  } finally {
    await client.end();
    db.close();
  }
}

if (process.argv.length !== 3 || !process.env.PGDATABASE || !process.env.PGHOST) {
  console.error('Set PGHOST, PGDATABASE, and PostgreSQL credentials, then run: node import-sqlite.mjs <forum.db>');
  process.exitCode = 1;
} else {
  try {
    const counts = await importSnapshot(process.argv[2]);
    console.log('Imported SQLite snapshot:', JSON.stringify(counts));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
