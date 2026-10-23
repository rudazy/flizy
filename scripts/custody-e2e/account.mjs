/**
 * The throwaway dev account the custody browser walk signs in as.
 *
 *   node scripts/custody-e2e/account.mjs create   new account, verified email, one-hour session
 *   node scripts/custody-e2e/account.mjs rows     its custody_passkeys and custody_delegations rows
 *   node scripts/custody-e2e/account.mjs remove   deletes its custody rows, session and the account
 *
 * Dev database only: web/.env.local must point at the project .env.dev
 * declares as dev (scripts/devDbTarget.js), or it refuses. State (id, password,
 * session token) goes to state.json next to this file, which is gitignored.
 */

import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const STATE = path.join(HERE, 'state.json');
const webRequire = createRequire(path.join(ROOT, 'web', 'package.json'));
const rootRequire = createRequire(path.join(ROOT, 'package.json'));

const env = webRequire('dotenv').parse(fs.readFileSync(path.join(ROOT, 'web', '.env.local')));
const { ref: devRef } = rootRequire('./scripts/devDbTarget').loadDevTarget(path.join(ROOT, '.env.dev'));
if (new URL(env.SUPABASE_URL).hostname !== `${devRef}.supabase.co`) {
  throw new Error('refusing: web/.env.local is not the dev database that .env.dev declares');
}
process.env.WALLET_DERIVATION_SECRET = env.WALLET_DERIVATION_SECRET;
const db = webRequire('@supabase/supabase-js').createClient(env.SUPABASE_URL, env.SUPABASE_KEY);

const action = process.argv[2];

if (action === 'create') {
  const { hashPassword } = await import(pathToFileURL(path.join(ROOT, 'web', 'lib', 'cryptoPin.ts')).href);
  const { predictGatorAddress } = rootRequire('./lib/gatorAccount');
  const id = crypto.randomUUID();
  const password = 'E2e-' + crypto.randomBytes(9).toString('base64url');
  const gator = predictGatorAddress(id);
  const username = 'e2ecust' + crypto.randomBytes(3).toString('hex');
  const ins = await db.from('accounts').insert({
    id,
    agent_wallet_address: gator,
    username,
    password_hash: hashPassword(password),
    // The dashboard waits on a verified email. .invalid can never receive mail.
    email: `${username}@example.invalid`,
    email_verified_at: new Date().toISOString(),
  });
  if (ins.error) throw new Error(ins.error.message);
  const token = crypto.randomBytes(32).toString('hex');
  const s = await db.from('web_sessions').insert({
    account_id: id,
    token_hash: crypto.createHash('sha256').update(token).digest('hex'),
    expires_at: new Date(Date.now() + 3600e3).toISOString(),
  });
  if (s.error) throw new Error(s.error.message);
  fs.writeFileSync(STATE, JSON.stringify({ id, password, gator, username, token }));
  console.log('created a throwaway dev account; its wallet is', gator);
} else if (action === 'rows') {
  const { id } = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  const keys = await db.from('custody_passkeys').select('*').eq('account_id', id);
  const dels = await db.from('custody_delegations').select('*').eq('account_id', id);
  if (keys.error || dels.error) throw new Error((keys.error || dels.error).message);
  console.log(JSON.stringify({ keys: keys.data, dels: dels.data }));
} else if (action === 'remove') {
  const { id } = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  for (const t of ['custody_delegations', 'custody_passkeys', 'custody_challenges', 'web_sessions']) {
    const r = await db.from(t).delete().eq('account_id', id);
    if (r.error) throw new Error(`${t}: ${r.error.message}`);
  }
  const r = await db.from('accounts').delete().eq('id', id);
  if (r.error) throw new Error(r.error.message);
  fs.rmSync(STATE, { force: true });
  fs.rmSync(path.join(HERE, 'delegate.txt'), { force: true });
  console.log('removed the throwaway account and its rows');
} else {
  throw new Error('use: create | rows | remove');
}
