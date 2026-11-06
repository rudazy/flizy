/**
 * Flizy Pay API administration: the approval list, payout permission and the
 * database half of the global payout switch. Flizy-side only; no platform can
 * do any of this through the API or the site.
 *
 * The database is named explicitly: --env-file is the only place SUPABASE_URL
 * and SUPABASE_KEY are read from. Without --confirm nothing is written; the
 * run prints what it would change.
 *
 * Commands (Windows CMD):
 *   node scripts\api-platform.mjs --env-file .env list
 *   node scripts\api-platform.mjs --env-file .env approve --username naru --name "NARU" [--fee-bps 0] [--expiry-days 30] [--expiry-max-days 30] --confirm
 *   node scripts\api-platform.mjs --env-file .env enable --username naru --confirm
 *   node scripts\api-platform.mjs --env-file .env disable --username naru --confirm
 *   node scripts\api-platform.mjs --env-file .env grant-payout --key fz_test_AbCdEf --confirm
 *   node scripts\api-platform.mjs --env-file .env revoke-payout --key fz_test_AbCdEf --confirm
 *   node scripts\api-platform.mjs --env-file .env payouts on --confirm
 *   node scripts\api-platform.mjs --env-file .env payouts off --confirm
 *   node scripts\api-platform.mjs --env-file .env limits --username naru --asset tUSD --max 50 --daily 500 --confirm
 *   node scripts\api-platform.mjs --env-file .env limits --username naru --asset tUSD --remove --confirm
 *
 * Approval binds the platform to the account's current Flizy wallet. Granting
 * payout is recorded by the api_key_events trigger and emailed to the owner.
 * API payouts also need API_PAYOUTS_ENABLED=true in the environment; this
 * script cannot set that.
 *
 * Limits are per asset (ETH, FLZ, tUSD): --max is the most one payout may move,
 * --daily the most a rolling day may move, and the platform's passkey-signed
 * allowance is for the daily amount. No limits row means that asset is refused.
 * Changing --daily takes effect on chain only once the platform signs again.
 */

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
const { parseUnits, formatUnits } = require('ethers');

/** Same table as lib/api/payoutWorker.js ASSETS. */
const ASSETS = { ETH: { label: 'ETH', decimals: 18 }, FLZ: { label: 'FLZ', decimals: 18 }, TUSD: { label: 'tUSD', decimals: 6 } };

function units(name, raw, decimals) {
  const s = String(raw || '').trim();
  if (!/^[0-9]+(\.[0-9]+)?$/.test(s)) throw new Error(`${name} must be a positive number`);
  let v;
  try {
    v = parseUnits(s, decimals);
  } catch {
    throw new Error(`${name} has more decimal places than the asset`);
  }
  if (v <= 0n) throw new Error(`${name} must be more than 0`);
  return v;
}

const argv = process.argv.slice(2);
function flag(name) {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1] ?? null;
}
const confirm = argv.includes('--confirm');
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && argv[i - 1] !== '--confirm'));
const [command, arg] = positional;

function intFlag(name, fallback, min, max) {
  const raw = flag(name);
  if (raw == null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max}`);
  return n;
}

async function accountByUsername(db, username) {
  const u = String(username || '').trim().toLowerCase().replace(/^@/, '');
  if (!/^[a-z0-9_]{2,32}$/.test(u)) throw new Error('--username is required');
  const { data, error } = await db.from('accounts').select('id, username, agent_wallet_address').eq('username', u).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`no account @${u}`);
  return data;
}

async function keyByPrefix(db, prefix) {
  const p = String(prefix || '').trim();
  if (!/^fz_(test|live)_[A-Za-z0-9_-]{6}$/.test(p)) throw new Error('--key takes the prefix shown on the Developers page, e.g. fz_test_AbCdEf');
  const { data, error } = await db.from('api_keys').select('id, prefix, scopes, revoked_at, platform_id').eq('prefix', p);
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) throw new Error(`no key ${p}`);
  if (data.length > 1) throw new Error(`more than one key has prefix ${p}; use the database to pick by id`);
  if (data[0].revoked_at) throw new Error(`key ${p} is revoked`);
  return data[0];
}

async function write(label, run) {
  if (!confirm) {
    console.log(`Dry run: would ${label}. Add --confirm to do it.`);
    return;
  }
  await run();
  console.log(`Done: ${label}.`);
}

async function main() {
  const envFile = flag('--env-file');
  if (!envFile) throw new Error('--env-file is required: the file that names the database');
  const env = dotenv.parse(readFileSync(path.resolve(envFile)));
  if (!env.SUPABASE_URL || !env.SUPABASE_KEY) throw new Error(`${envFile} must set SUPABASE_URL and SUPABASE_KEY`);
  const ref = new URL(env.SUPABASE_URL).hostname.split('.')[0];
  console.log(`Database: Supabase project ${ref} (from ${envFile}).`);
  const db = createClient(env.SUPABASE_URL, env.SUPABASE_KEY, { auth: { persistSession: false } });

  switch (command) {
    case 'list': {
      const { data: control } = await db.from('api_control').select('payouts_enabled').eq('id', true).maybeSingle();
      console.log(`Database payout switch: ${control?.payouts_enabled ? 'on' : 'off'}`);
      const { data, error } = await db.from('api_platforms').select('id, display_name, wallet_address, enabled, fee_bps, claim_expiry_default_days, claim_expiry_max_days');
      if (error) throw new Error(error.message);
      for (const p of data || []) {
        console.log(`${p.enabled ? 'enabled ' : 'disabled'} ${p.display_name} wallet ${p.wallet_address} fee ${p.fee_bps}bps claims ${p.claim_expiry_default_days}/${p.claim_expiry_max_days}d`);
        const { data: keys } = await db.from('api_keys').select('prefix, mode, scopes, revoked_at').eq('platform_id', p.id);
        for (const k of keys || []) console.log(`    ${k.prefix} ${k.mode} [${k.scopes.join(', ')}]${k.revoked_at ? ' revoked' : ''}`);
      }
      return;
    }
    case 'approve': {
      const account = await accountByUsername(db, flag('--username'));
      const name = String(flag('--name') || '').trim();
      if (!name || name.length > 60) throw new Error('--name is required, up to 60 characters: the name recipients see');
      const wallet = String(account.agent_wallet_address || '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(wallet)) throw new Error(`@${account.username} has no Flizy wallet yet`);
      const row = {
        account_id: account.id,
        display_name: name,
        wallet_address: wallet,
        enabled: true,
        fee_bps: intFlag('--fee-bps', 0, 0, 1000),
        claim_expiry_default_days: intFlag('--expiry-days', 30, 1, 365),
        claim_expiry_max_days: intFlag('--expiry-max-days', 30, 1, 365),
      };
      if (row.claim_expiry_default_days > row.claim_expiry_max_days) throw new Error('--expiry-days cannot exceed --expiry-max-days');
      await write(`approve @${account.username} as "${name}" bound to ${wallet}`, async () => {
        const { error } = await db.from('api_platforms').insert(row);
        if (error) throw new Error(error.message);
      });
      return;
    }
    case 'enable':
    case 'disable': {
      const account = await accountByUsername(db, flag('--username'));
      await write(`${command} the platform of @${account.username}`, async () => {
        const { data, error } = await db
          .from('api_platforms')
          .update({ enabled: command === 'enable', updated_at: new Date().toISOString() })
          .eq('account_id', account.id)
          .select('id');
        if (error) throw new Error(error.message);
        if (!data || data.length === 0) throw new Error(`@${account.username} is not an approved platform`);
      });
      return;
    }
    case 'grant-payout':
    case 'revoke-payout': {
      const key = await keyByPrefix(db, flag('--key'));
      const has = key.scopes.includes('payout');
      const scopes = command === 'grant-payout' ? [...new Set([...key.scopes, 'payout'])] : key.scopes.filter((s) => s !== 'payout');
      if (scopes.length === 0) throw new Error('a key needs at least one permission; revoke the key instead');
      if ((command === 'grant-payout') === has) {
        console.log(`Nothing to do: ${key.prefix} ${has ? 'already has' : 'does not have'} payout.`);
        return;
      }
      await write(`set ${key.prefix} permissions to [${scopes.join(', ')}]`, async () => {
        const { error } = await db.from('api_keys').update({ scopes }).eq('id', key.id);
        if (error) throw new Error(error.message);
      });
      return;
    }
    case 'limits': {
      const account = await accountByUsername(db, flag('--username'));
      const symbol = String(flag('--asset') || '').trim().toUpperCase();
      const asset = ASSETS[symbol];
      if (!asset) throw new Error('--asset must be ETH, FLZ or tUSD');
      const { data: platform, error: pErr } = await db.from('api_platforms').select('id').eq('account_id', account.id).maybeSingle();
      if (pErr) throw new Error(pErr.message);
      if (!platform) throw new Error(`@${account.username} is not an approved platform`);
      if (argv.includes('--remove')) {
        await write(`remove ${asset.label} payouts for @${account.username}`, async () => {
          const { error } = await db.from('api_platform_limits').delete().eq('platform_id', platform.id).eq('symbol', symbol);
          if (error) throw new Error(error.message);
        });
        return;
      }
      const max = units('--max', flag('--max'), asset.decimals);
      const daily = units('--daily', flag('--daily'), asset.decimals);
      if (max > daily) throw new Error('--max cannot exceed --daily');
      await write(
        `set @${account.username} ${asset.label} limits: ${formatUnits(max, asset.decimals)} per payout, ${formatUnits(daily, asset.decimals)} a day`,
        async () => {
          const { error } = await db
            .from('api_platform_limits')
            .upsert({ platform_id: platform.id, symbol, max_payout: max.toString(), daily_max: daily.toString(), updated_at: new Date().toISOString() }, { onConflict: 'platform_id,symbol' });
          if (error) throw new Error(error.message);
        }
      );
      return;
    }
    case 'payouts': {
      if (arg !== 'on' && arg !== 'off') throw new Error('payouts takes on or off');
      await write(`turn the database payout switch ${arg}`, async () => {
        const { error } = await db.from('api_control').update({ payouts_enabled: arg === 'on', updated_at: new Date().toISOString() }).eq('id', true);
        if (error) throw new Error(error.message);
      });
      return;
    }
    default:
      throw new Error('commands: list, approve, enable, disable, grant-payout, revoke-payout, payouts on|off, limits');
  }
}

main().catch((err) => {
  console.error(`api-platform: ${String(err && err.message ? err.message : err).slice(0, 300)}`);
  process.exitCode = 1;
});
