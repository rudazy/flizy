/**
 * Force email re-verify + log out all web sessions.
 * Usage: node scripts/run-force-email-reverify.js
 * Only after Gmail SMTP is working in production.
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
  path.join(__dirname, '..', 'supabase', 'migrations', '20260806010000_force_email_reverify.sql'),
  'utf8'
);

const targets = [
  { host: `db.${ref}.supabase.co`, port: 5432, user: 'postgres' },
  { host: 'aws-0-eu-west-1.pooler.supabase.com', port: 6543, user: `postgres.${ref}` },
  { host: 'aws-0-eu-central-1.pooler.supabase.com', port: 6543, user: `postgres.${ref}` },
  { host: 'aws-0-us-east-1.pooler.supabase.com', port: 6543, user: `postgres.${ref}` },
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
      const v = await client.query(
        `select count(*)::int as n from public.accounts where email is not null and email_verified_at is null`
      );
      const s = await client.query(`select count(*)::int as n from public.web_sessions`);
      console.log('Unverified accounts with email:', v.rows[0]?.n);
      console.log('Remaining web_sessions:', s.rows[0]?.n);
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
  console.error('Failed:', lastErr && lastErr.message);
  process.exit(1);
}

main();
