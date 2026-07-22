/**
 * Apply a SQL migration file to Supabase Postgres.
 * Usage: node scripts/run-migration-file.js supabase/migrations/FILE.sql
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/run-migration-file.js path/to/migration.sql');
  process.exit(1);
}

const password = process.env.SUPABASE_DB_PASSWORD;
const url = process.env.SUPABASE_URL || '';
const m = url.match(/https?:\/\/([a-z0-9]+)\.supabase\.co/i);
const ref = m ? m[1] : '';
if (!password || !ref) {
  console.error('Need SUPABASE_URL and SUPABASE_DB_PASSWORD');
  process.exit(1);
}

const sql = fs.readFileSync(path.resolve(file), 'utf8');

async function main() {
  const client = new Client({
    host: `db.${ref}.supabase.co`,
    port: 5432,
    user: 'postgres',
    password,
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  await client.query(sql);
  console.log('Applied:', file);
  await client.end();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
