/**
 * Backfill the pair event index (supabase/migrations/20261103120000_pair_events.sql)
 * from each listed pair's deploy block to the chain head.
 *
 * Only the listed pairs, from the token config (web/lib/listedPairs.ts): FLZ's
 * pool and each listed token's pool. The factory's other pairs are never read.
 * Each pair's deploy block is found on chain (the first block with code at its
 * address), and each pair's token order is checked against token0() before
 * anything is written. Rows are keyed by chain, tx hash and log index, so
 * running this twice, or alongside the poller, writes each log once.
 *
 * The database is named explicitly: --env-file is the only place the Supabase
 * URL and service key are read from; process.env and the repo .env are not
 * consulted for them. Without --confirm nothing is written: the run reads the
 * chain and reports what it would write.
 *
 * Usage (Windows CMD):
 *   node scripts\backfill-pair-events.mjs --env-file .env.dev
 *   node scripts\backfill-pair-events.mjs --env-file .env.dev --confirm
 */

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
const { ethers } = require('ethers');

const { listedPairs } = await import('../web/lib/listedPairs.ts');
const { indexRange, advanceCursor } = await import('../web/lib/pairEvents.ts');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1] || null;
}

/** First block at which the address holds code, by binary search over getCode. */
async function deployBlock(provider, address, head) {
  if ((await provider.getCode(address, head)) === '0x') throw new Error(`${address} has no code at the head`);
  let lo = 0;
  let hi = head;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await provider.getCode(address, mid)) === '0x') lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** A database stand-in for a dry run: accepts every write and counts the rows. */
function dryRunDb() {
  let rows = 0;
  const query = {
    upsert(values) {
      if (Array.isArray(values)) rows += values.length;
      return query;
    },
    update: () => query,
    eq: () => query,
    lt: () => query,
    then: (resolve) => resolve({ data: null, error: null }),
  };
  return { db: { from: () => query }, rows: () => rows };
}

async function main() {
  const envFile = arg('--env-file');
  if (!envFile) throw new Error('--env-file is required: the file that names the database to write');
  const env = dotenv.parse(readFileSync(path.resolve(envFile)));
  const confirm = process.argv.includes('--confirm');

  const deployed = JSON.parse(readFileSync(path.join(ROOT, 'deployments', 'giwa-sepolia.json'), 'utf8')).contracts || {};
  // Same precedence as getDexAddresses on the site: an env override, then the deployment.
  const dex = {
    flz: ethers.getAddress(env.CHAIN_GIWA_SEPOLIA_FLZ || deployed.flz),
    pair: ethers.getAddress(env.CHAIN_GIWA_SEPOLIA_FLZ_WETH_PAIR || deployed.pairFlzWeth),
    wrappedNative: ethers.getAddress(env.CHAIN_GIWA_SEPOLIA_WETH || deployed.weth),
  };
  const pairs = listedPairs(dex);
  const rpc = env.GIWA_RPC || env.CHAIN_GIWA_SEPOLIA_RPC || 'https://sepolia-rpc.giwa.io';
  const provider = new ethers.JsonRpcProvider(rpc, undefined, { staticNetwork: true });
  const chainId = Number((await provider.getNetwork()).chainId);

  let db;
  let counted = null;
  if (confirm) {
    if (!env.SUPABASE_URL || !(env.SUPABASE_KEY || env.SUPABASE_SERVICE_ROLE_KEY)) {
      throw new Error(`${envFile} must set SUPABASE_URL and SUPABASE_KEY`);
    }
    const ref = new URL(env.SUPABASE_URL).hostname.split('.')[0];
    console.log(`Writing to Supabase project ${ref} (from ${envFile}).`);
    db = createClient(env.SUPABASE_URL, env.SUPABASE_KEY || env.SUPABASE_SERVICE_ROLE_KEY);
  } else {
    counted = dryRunDb();
    db = counted.db;
    console.log('Dry run: reading the chain only. Add --confirm to write.');
  }

  const head = await provider.getBlockNumber();
  console.log(`Chain ${chainId}, head ${head}.`);
  for (const p of pairs) {
    // The token order the index prices by must be the pair's own.
    const token0 = String(await new ethers.Contract(p.pair, ['function token0() view returns (address)'], provider).token0());
    if ((token0.toLowerCase() === p.token.toLowerCase()) !== p.tokenIs0) {
      throw new Error(`${p.symbol}: token0 on chain does not match the computed order. Nothing written for it.`);
    }
    const from = await deployBlock(provider, ethers.getAddress(p.pair), head);
    const result = await indexRange({ provider, db, chainId, pairs: [p], from, to: head });
    if (confirm && result.contiguousTo >= from) await advanceCursor(db, chainId, p.pair, result.contiguousTo);
    const gaps = result.failed.length ? `, ${result.failed.length} chunk(s) refused twice: run again to fill them` : '';
    console.log(`${p.symbol} ${p.pair} from block ${from}: ${result.rows} log(s)${gaps}.`);
  }
  if (counted) console.log(`Would write ${counted.rows()} row(s).`);
  provider.destroy();
}

main().catch((err) => {
  console.error(`backfill-pair-events: ${String(err && err.message ? err.message : err).slice(0, 300)}`);
  process.exitCode = 1;
});
