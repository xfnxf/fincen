const username = process.argv[2];
if (process.argv.length !== 3 || !/^[A-Za-z0-9_.]{3,20}$/.test(username || '')) {
  console.error('Usage: npm run admin -- <registered username>');
  process.exit(1);
}

const db = require('./db');
try {
  const result = db.prepare(`UPDATE users SET role = 'admin'
    WHERE username = ? AND banned = 0 AND retired_at IS NULL`).run(username);
  if (result.changes) {
    console.log('Administrator access granted to ' + username + '.');
  } else {
    console.error('No active account found for ' + username + '. Register it first.');
    process.exitCode = 1;
  }
} finally {
  db.close();
}
