/**
 * Local admin: set (or replace) a site login password for an account by email.
 *
 * Usage (from repo root, with .env loaded):
 *   node scripts/set-account-password.js you@email.com "NewPass1!"
 *
 * Then sign in at https://flizy.app/login with that email + password.
 * All existing web sessions for that account are revoked.
 *
 * Never commit passwords. Never run this against a shared screen recording.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SPECIAL = /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/;

function validatePassword(password) {
  const p = String(password || '');
  if (p.length < 8) return 'Password must be at least 8 characters';
  if (p.length > 128) return 'Password is too long';
  if (!/[a-zA-Z]/.test(p)) return 'Password must include a letter';
  if (!/[0-9]/.test(p)) return 'Password must include a number';
  if (!SPECIAL.test(p)) return 'Password must include a special character (e.g. !@#$%)';
  return null;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32, SCRYPT_PARAMS);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

async function main() {
  const email = String(process.argv[2] || '')
    .trim()
    .toLowerCase();
  const password = String(process.argv[3] || '');

  if (!email || !password) {
    console.error('Usage: node scripts/set-account-password.js email@example.com "NewPass1!"');
    process.exit(1);
  }

  const bad = validatePassword(password);
  if (bad) {
    console.error(bad);
    process.exit(1);
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) {
    console.error('Need SUPABASE_URL and SUPABASE_KEY in .env');
    process.exit(1);
  }

  const sb = createClient(url, key);
  const { data: account, error: findErr } = await sb
    .from('accounts')
    .select('id, email, display_name, password_hash')
    .eq('email', email)
    .maybeSingle();

  if (findErr) {
    console.error('Lookup failed:', findErr.message);
    process.exit(1);
  }
  if (!account) {
    console.error('No account with that email. Check spelling (login lowercases email).');
    process.exit(1);
  }

  const password_hash = hashPassword(password);
  const { error: upErr } = await sb.from('accounts').update({ password_hash }).eq('id', account.id);
  if (upErr) {
    console.error('Update failed:', upErr.message);
    process.exit(1);
  }

  // Drop every site session so only the new password can open a fresh one
  const { error: sessErr } = await sb.from('web_sessions').delete().eq('account_id', account.id);
  if (sessErr) {
    console.warn('Password set, but could not clear web_sessions:', sessErr.message);
  }

  console.log('OK. Password set for', account.email, account.display_name ? `(${account.display_name})` : '');
  console.log('Sign in at https://flizy.app/login');
  console.log('Had a previous password hash:', Boolean(account.password_hash));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
