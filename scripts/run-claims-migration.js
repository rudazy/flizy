/**
 * One-shot: apply claims escrow columns migration.
 * Usage: node scripts/run-claims-migration.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const password = process.env.SUPABASE_DB_PASSWORD;
const url = process.env.SUPABASE_URL || '';
const m = url.match(/https?:\/\/([a-z0-9]+)\.supabase\.co/i);
const ref = m ? m[1] : '';

if (!password || !ref) {
  console.error('Need SUPABASE_URL and SUPABASE_DB_PASSWORD in .env');
  process.exit(1);
}

const sql = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'migrations', '20260722100000_claims_escrow.sql'),
  'utf8'
);

const targets = [
  {
    host: `db.${ref}.supabase.co`,
    port: 5432,
    user: 'postgres',
  },
  {
    host: `aws-0-eu-central-1.pooler.supabase.com`,
    port: 6543,
    user: `postgres.${ref}`,
  },
  {
    host: `aws-0-us-east-1.pooler.supabase.com`,
    port: 6543,
    user: `postgres.${ref}`,
  },
];

async function main() {
  let lastErr;
  for (const t of targets) {
    const client = new Client({
      host: t.host,
      port: t.port,
      user: t.user,
      password,
      database: 'postgres',
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 20000,
    });
    try {
      await client.connect();
      console.log('Connected:', t.host);
      await client.query(sql);
      console.log('Migration applied.');
      const check = await client.query(`
        select column_name
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'claims'
          and column_name in ('hold_tx_hash', 'from_wa_sender', 'refund_tx_hash', 'claim_tx_hash')
        order by 1
      `);
      console.log(
        'Verified columns:',
        check.rows.map((r) => r.column_name).join(', ') || '(none)'
      );
      await client.end();
      return;
    } catch (e) {
      lastErr = e;
      console.warn('Failed', t.host, '-', e.message);
      try {
        await client.end();
      } catch {
        /* ignore */
      }
    }
  }
  console.error('Could not apply migration:', lastErr && lastErr.message);
  process.exit(1);
}

main();
