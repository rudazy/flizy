/**
 * Move tester wallets from HMAC EOAs onto their HybridDeleGator.
 *
 * Per account: inspect, skip if in-flight, deploy gator if needed, sweep
 * NFTs then FLZ then ETH, then flip agent_wallet_address. Dry run is the
 * default. Pointer flip is last because claims pay out to whatever that
 * column says.
 *
 * Open chat confirms live in process memory and cannot be seen here. Stop
 * the bot or accept that a mid-confirm send still aims at the old EOA.
 *
 * CMD:
 *   node scripts\migrate-gator-wallets.js
 *   node scripts\migrate-gator-wallets.js --broadcast
 */
require('dotenv').config();
const { ethers } = require('ethers');

const { requireEnv } = require('../lib/config');
const { getDefaultChain, explorerTxUrl } = require('../lib/chains');
const { getSupabase } = require('../lib/supabase');
const {
  deriveAgentWallet,
  deriveLegacyWalletV1,
  deriveLegacyAddressV1,
} = require('../lib/agentWallet');
const { predictGatorAddress } = require('../lib/gatorAccount');
const { ensureGatorDeployed } = require('../lib/gatorExecute');
const { listedNfts } = require('../lib/listedNfts');

requireEnv(['SUPABASE_URL', 'SUPABASE_KEY', 'WALLET_DERIVATION_SECRET']);

const BROADCAST = process.argv.includes('--broadcast');
const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];
const NFT_ABI = [
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function transferFrom(address from, address to, uint256 tokenId)',
  'function balanceOf(address) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
];

const SWEEP_GAS_RESERVE = ethers.parseEther('0.00002');
const GAS_TOPUP = ethers.parseEther('0.0002');

function fmt(wei) {
  return ethers.formatEther(wei);
}

async function listAccounts() {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('accounts')
    .select('id, agent_wallet_address')
    .order('created_at', { ascending: true });
  if (error) throw new Error(`accounts read failed: ${error.message}`);
  return data || [];
}

async function inflightFor(accountId) {
  const supabase = getSupabase();
  const { data: asFrom, error: fromErr } = await supabase
    .from('claims')
    .select('id, status, from_account_id, to_account_id')
    .in('status', ['pending', 'processing'])
    .eq('from_account_id', accountId);
  if (fromErr) throw new Error(`claims read failed: ${fromErr.message}`);
  const { data: asTo, error: toErr } = await supabase
    .from('claims')
    .select('id, status, from_account_id, to_account_id')
    .in('status', ['pending', 'processing'])
    .eq('to_account_id', accountId);
  if (toErr) throw new Error(`claims read failed: ${toErr.message}`);
  const { data: transfers, error: tErr } = await supabase
    .from('transfers')
    .select('id, status')
    .eq('account_id', accountId)
    .in('status', ['pending', 'submitted']);
  if (tErr) throw new Error(`transfers read failed: ${tErr.message}`);
  const seen = new Set();
  const claimRows = [];
  for (const row of [...(asFrom || []), ...(asTo || [])]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    claimRows.push(row);
  }
  const transferRows = transfers || [];
  const reasons = [];
  const asRecipient = claimRows.filter((c) => c.to_account_id === accountId);
  const asSender = claimRows.filter((c) => c.from_account_id === accountId);
  if (asRecipient.length) {
    reasons.push(`${asRecipient.length} pending/processing claim(s) as recipient`);
  }
  if (asSender.length) {
    reasons.push(`${asSender.length} pending/processing claim(s) as sender (escrow)`);
  }
  if (transferRows.length) {
    reasons.push(`${transferRows.length} in-flight transfer(s)`);
  }
  return { skip: reasons.length > 0, reasons, claims: claimRows, transfers: transferRows };
}

async function nftsHeld(address, collections, provider) {
  const out = [];
  const owner = ethers.getAddress(address);
  for (const col of collections) {
    const nft = new ethers.Contract(col.address, NFT_ABI, provider);
    let ids = [];
    let bal = 0n;
    try {
      bal = await nft.balanceOf(owner);
    } catch {
      continue;
    }
    if (bal === 0n) continue;
    try {
      for (let i = 0n; i < bal; i += 1n) {
        ids.push(await nft.tokenOfOwnerByIndex(owner, i));
      }
    } catch {
      const supply = await nft.totalSupply();
      const max = supply > 2000n ? 2000n : supply;
      console.log(`  ${col.ticker} balance ${bal} on ${address}; ownerOf 1..${max}`);
      for (let i = 1n; i <= max; i += 1n) {
        try {
          const who = await nft.ownerOf(i);
          if (ethers.getAddress(who) === owner) ids.push(i);
        } catch {
          /* missing id */
        }
      }
    }
    for (const id of ids) {
      out.push({ ticker: col.ticker, address: col.address, tokenId: id.toString() });
    }
  }
  return out;
}

async function withRetry(fn, label, attempts = 3) {
  let last;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      console.warn(`  retry ${i}/${attempts} ${label}: ${err.message || err}`);
      await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
  throw last;
}

async function inspectSource(label, address, gator, provider, tokens, collections) {
  const ethWei = await provider.getBalance(address);
  const tokenBalances = [];
  for (const token of tokens) {
    const contract = new ethers.Contract(token.address, ERC20_ABI, provider);
    const raw = await withRetry(
      () => contract.balanceOf(address),
      `${token.symbol} on ${address}`
    );
    if (raw > 0n) tokenBalances.push({ ...token, raw });
  }
  const nfts = await nftsHeld(address, collections, provider);
  const same = ethers.getAddress(address) === ethers.getAddress(gator);
  return { label, address, ethWei, tokenBalances, nfts, same };
}

function hasMovable(src) {
  if (src.same) return false;
  return src.ethWei > 0n || src.tokenBalances.length > 0 || src.nfts.length > 0;
}

async function sweepSource(src, gator, signer, provider, chain, opsWallet) {
  if (src.same || !hasMovable(src)) return { ok: true, moved: [] };
  const moved = [];
  let gasWei = await provider.getBalance(src.address);

  const needsGas = (src.tokenBalances.length > 0 || src.nfts.length > 0) && gasWei < GAS_TOPUP;
  if (needsGas) {
    if (!opsWallet) throw new Error('ops wallet required to fund gas for token/NFT sweep');
    const fund = await opsWallet.sendTransaction({ to: src.address, value: GAS_TOPUP });
    const fundRcpt = await fund.wait(1);
    if (!fundRcpt || fundRcpt.status !== 1) throw new Error('gas top-up failed');
    moved.push(`gas top-up ${explorerTxUrl(chain, fund.hash)}`);
    gasWei = await provider.getBalance(src.address);
  }

  for (const nft of src.nfts) {
    const contract = new ethers.Contract(nft.address, NFT_ABI, signer);
    const tx = await contract.transferFrom(src.address, gator, nft.tokenId);
    const rcpt = await tx.wait(1);
    if (!rcpt || rcpt.status !== 1) throw new Error(`NFT ${nft.ticker} #${nft.tokenId} transfer failed`);
    moved.push(`${nft.ticker} #${nft.tokenId} ${explorerTxUrl(chain, tx.hash)}`);
  }

  for (const token of src.tokenBalances) {
    const contract = new ethers.Contract(token.address, ERC20_ABI, signer);
    const tx = await contract.transfer(gator, token.raw);
    const rcpt = await tx.wait(1);
    if (!rcpt || rcpt.status !== 1) throw new Error(`${token.symbol} transfer failed`);
    moved.push(`${token.symbol} ${explorerTxUrl(chain, tx.hash)}`);
  }

  const balanceNow = await provider.getBalance(src.address);
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.maxFeePerGas || feeData.gasPrice || 0n;
  const gasCost = gasPrice * 21000n * 4n;
  const keepBack = gasCost > SWEEP_GAS_RESERVE ? gasCost : SWEEP_GAS_RESERVE;
  if (balanceNow > keepBack) {
    const value = balanceNow - keepBack;
    const tx = await signer.sendTransaction({ to: gator, value });
    const rcpt = await tx.wait(1);
    if (!rcpt || rcpt.status !== 1) throw new Error('ETH sweep failed');
    moved.push(`${fmt(value)} ETH ${explorerTxUrl(chain, tx.hash)}`);
  }
  return { ok: true, moved };
}

async function flipPointer(accountId, gator) {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('accounts')
    .update({ agent_wallet_address: gator })
    .eq('id', accountId);
  if (error) throw new Error(`pointer update failed: ${error.message}`);
}

function reportLine(row) {
  const bits = [];
  for (const src of row.sources) {
    if (!hasMovable(src)) continue;
    const toks = src.tokenBalances
      .map((t) => `${ethers.formatUnits(t.raw, t.decimals)} ${t.symbol}`)
      .join(', ');
    const nfts = src.nfts.map((n) => `${n.ticker}#${n.tokenId}`).join(', ');
    bits.push(
      `${src.label} ${src.address}: ${fmt(src.ethWei)} ETH` +
        (toks ? `; ${toks}` : '') +
        (nfts ? `; ${nfts}` : '')
    );
  }
  return bits.length ? bits.join(' | ') : 'nothing to move';
}

async function main() {
  const chain = getDefaultChain();
  const network = ethers.Network.from(chain.chainId);
  const provider = new ethers.JsonRpcProvider(chain.rpcUrl, network, {
    staticNetwork: true,
  });
  const tokens = [];
  if (chain.flzToken) {
    tokens.push({
      symbol: 'FLZ',
      address: ethers.getAddress(chain.flzToken),
      decimals: 18,
    });
  }
  const collections = listedNfts(chain.id).map((n) => ({
    ticker: n.ticker,
    address: ethers.getAddress(n.address),
  }));

  const accounts = await listAccounts();
  console.log('');
  console.log('Flizy HMAC EOA -> HybridDeleGator');
  console.log(`Chain:    ${chain.name} (${chain.chainId})`);
  console.log(`Tokens:   ${tokens.map((t) => t.symbol).join(', ') || 'none'}`);
  console.log(`NFTs:     ${collections.map((c) => c.ticker).join(', ') || 'none'}`);
  console.log(`Accounts: ${accounts.length}`);
  console.log(`Mode:     ${BROADCAST ? 'BROADCAST' : 'DRY RUN (reads only)'}`);
  console.log('In-memory chat confirms are invisible here. Stop the bot first if that matters.');
  console.log('');

  const rows = [];
  let n = 0;
  for (const account of accounts) {
    n += 1;
    console.log(`Inspecting ${n}/${accounts.length} ${account.id}`);
    const hmac = deriveAgentWallet(account.id).address;
    const v1 = deriveLegacyAddressV1(account.id);
    const gator = predictGatorAddress(account.id);
    const stored = account.agent_wallet_address
      ? ethers.getAddress(account.agent_wallet_address)
      : null;
    const inflight = await inflightFor(account.id);
    const sources = [];
    for (const [label, address] of [
      ['v1', v1],
      ['hmac', hmac],
    ]) {
      sources.push(await inspectSource(label, address, gator, provider, tokens, collections));
    }
    rows.push({ account, stored, hmac, v1, gator, inflight, sources });
  }

  let moveCount = 0;
  let skipCount = 0;
  let alreadyCount = 0;

  for (const row of rows) {
    const movable = row.sources.some(hasMovable);
    const pointerDone = row.stored && row.stored === ethers.getAddress(row.gator);
    let action = 'migrate';
    if (row.inflight.skip) {
      action = `SKIP ${row.inflight.reasons.join('; ')}`;
      skipCount += 1;
    } else if (!movable && pointerDone) {
      action = 'already on gator';
      alreadyCount += 1;
    } else if (!movable && row.stored && row.stored !== ethers.getAddress(row.hmac) && row.stored !== ethers.getAddress(row.v1) && row.stored !== ethers.getAddress(row.gator)) {
      action = `SKIP unknown pointer ${row.stored}`;
      skipCount += 1;
    } else if (movable) {
      moveCount += 1;
    } else {
      action = 'flip pointer only';
      moveCount += 1;
    }
    console.log(`Account ${row.account.id}`);
    console.log(`  stored  ${row.stored || '(none)'}`);
    console.log(`  hmac    ${row.hmac}`);
    console.log(`  gator   ${row.gator}`);
    console.log(`  hold    ${reportLine(row)}`);
    console.log(`  action  ${action}`);
    console.log('');
  }

  console.log(`Would migrate: ${moveCount}  skip: ${skipCount}  already: ${alreadyCount}`);
  console.log('');

  if (!BROADCAST) {
    console.log('Dry run only. Nothing was sent and no pointers were flipped.');
    console.log('To apply: node scripts\\migrate-gator-wallets.js --broadcast');
    return;
  }

  requireEnv(['PRIVATE_KEY']);
  const opsWallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  console.log(`Ops (deploy + gas top-up): ${opsWallet.address}`);
  console.log('');

  let ok = 0;
  let failed = 0;
  for (const row of rows) {
    if (row.inflight.skip) continue;
    const unknown =
      row.stored &&
      row.stored !== ethers.getAddress(row.hmac) &&
      row.stored !== ethers.getAddress(row.v1) &&
      row.stored !== ethers.getAddress(row.gator);
    if (unknown) continue;
    const pointerDone = row.stored && row.stored === ethers.getAddress(row.gator);
    const movable = row.sources.some(hasMovable);
    if (!movable && pointerDone) continue;

    console.log(`Account ${row.account.id}`);
    try {
      await ensureGatorDeployed(row.account.id, provider);
      const hmacSigner = deriveAgentWallet(row.account.id).connect(provider);
      const v1Signer = deriveLegacyWalletV1(row.account.id).connect(provider);
      for (const src of row.sources) {
        if (!hasMovable(src)) continue;
        const signer = src.label === 'v1' ? v1Signer : hmacSigner;
        const result = await sweepSource(src, row.gator, signer, provider, chain, opsWallet);
        for (const line of result.moved) console.log(`  ${line}`);
      }
      if (!pointerDone) {
        await flipPointer(row.account.id, row.gator);
        console.log(`  pointer -> ${row.gator}`);
      }
      ok += 1;
    } catch (err) {
      failed += 1;
      console.error(`  FAILED ${err.message || err}`);
    }
    console.log('');
  }

  console.log(`Swept: ${ok}  failed: ${failed}  skipped: ${skipCount}`);
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
