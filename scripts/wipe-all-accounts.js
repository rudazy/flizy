/**
 * DESTRUCTIVE: wipe every account and dependent rows so everyone re-registers.
 *
 * Usage:
 *   node scripts/wipe-all-accounts.js --confirm
 *
 * Requires SUPABASE_URL + SUPABASE_KEY in .env.
 * Only clears the database (accounts, chat links, claims, history, sessions).
 * Does not move on-chain funds. Agent wallets for new signups use new account ids.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');

const confirmed = process.argv.includes('--confirm');

const TABLES = [
  'notifications',
  'payment_requests',
  'claims',
  'transfers',
  'web_sessions',
  'sessions',
  'link_codes',
  'trusted_addresses',
  'channel_identities',
  'whatsapp_identities',
  'contacts',
  'users',
  'accounts',
];

async function count(sb, table) {
  const r = await sb.from(table).select('*', { count: 'exact', head: true });
  if (r.error) return null;
  return r.count;
}

async function wipeTable(sb, table) {
  // Match all real rows (uuid / serial ids are never the nil uuid)
  let r = await sb.from(table).delete().neq('id', '00000000-0000-0000-0000-000000000000');
  if (r.error) {
    r = await sb.from(table).delete().gte('created_at', '1970-01-01');
  }
  if (r.error) throw new Error(`${table}: ${r.error.message}`);
}

async function main() {
  if (!confirmed) {
    console.error('Refusing to wipe without --confirm');
    console.error('Usage: node scripts/wipe-all-accounts.js --confirm');
    process.exit(1);
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) {
    console.error('Need SUPABASE_URL and SUPABASE_KEY in .env');
    process.exit(1);
  }

  const sb = createClient(url, key);

  const before = {};
  for (const t of TABLES) before[t] = await count(sb, t);
  console.log('Before:', before);

  for (const t of TABLES) {
    await wipeTable(sb, t);
    console.log('wiped', t);
  }

  const after = {};
  for (const t of TABLES) after[t] = await count(sb, t);
  console.log('After:', after);
  console.log('Done. Everyone must re-register at https://flizy.app/signup');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
