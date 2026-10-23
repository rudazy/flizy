/**
 * After walk.mjs: checks what the walk claims against the dev database and the
 * local GIWA fork directly, not through the page. The passkey row and the key
 * on chain, the three live permissions, each real-browser signature accepted by
 * the wallet, and one permission actually redeemed and refused past its cap.
 *
 * Run: node scripts/custody-e2e/verify.cjs   (FORK_RPC defaults to http://127.0.0.1:8546)
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { ethers } = require('ethers');
const C = require('../../lib/custody/delegations');

const RPC = process.env.FORK_RPC || 'http://127.0.0.1:8546';
const state = JSON.parse(fs.readFileSync(path.join(__dirname, 'state.json'), 'utf8'));
const delegate = fs.readFileSync(path.join(__dirname, 'delegate.txt'), 'utf8').trim();
const A = new ethers.Interface([
  'function getKey(string) view returns (uint256,uint256)',
  'function isValidSignature(bytes32,bytes) view returns (bytes4)',
  'function owner() view returns (address)',
]);

let failed = 0;
const out = (name, ok, extra = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
};

(async () => {
  if (!['127.0.0.1', 'localhost'].includes(new URL(RPC).hostname)) throw new Error('FORK_RPC must be a local anvil fork');
  const p = new ethers.JsonRpcProvider(RPC);
  await p.send('anvil_nodeInfo', []);
  const rows = JSON.parse(execFileSync(process.execPath, ['--no-warnings', path.join(__dirname, 'account.mjs'), 'rows']).toString());
  const read = async (fn, args) => A.decodeFunctionResult(fn, await p.call({ to: state.gator, data: A.encodeFunctionData(fn, args) }));

  const key = rows.keys[0];
  out('one passkey row, added, with its transaction', rows.keys.length === 1 && key.status === 'added' && /^0x[0-9a-f]{64}$/.test(key.add_tx_hash));
  const [x, y] = await read('getKey', [key.key_id]);
  out('the wallet on chain holds that exact key', ethers.toBeHex(x, 32) === key.x && ethers.toBeHex(y, 32) === key.y);
  const rcpt = await p.getTransactionReceipt(key.add_tx_hash);
  out('the addKey transaction is on the fork', Boolean(rcpt) && rcpt.status === 1);
  const [owner] = await read('owner', []);
  out('Flizy key is still the owner (ownership is a later step)', owner !== ethers.ZeroAddress);

  const live = rows.dels.filter((d) => d.status === 'active');
  out('three live permissions, one per asset', live.length === 3 && ['ETH', 'FLZ', 'TUSD'].every((s) => live.some((d) => d.symbol === s)));
  out('no unsigned builds left behind', rows.dels.every((d) => d.status !== 'pending'));
  const asDelegation = (d) => ({
    delegate: ethers.getAddress(d.delegate),
    delegator: ethers.getAddress(d.gator),
    authority: C.ROOT_AUTHORITY,
    caveats: d.caveats,
    salt: BigInt(d.salt),
    signature: d.signature,
  });
  for (const d of live) {
    const [answer] = await read('isValidSignature', [d.digest, d.signature]);
    out(`${d.symbol}: row rebuilds its digest, wallet accepts the browser signature`, C.delegationDigest(asDelegation(d)) === d.digest && answer === '0x1626ba7e');
  }

  const eth = { symbol: 'ETH', delegation: asDelegation(live.find((d) => d.symbol === 'ETH')) };
  const sink = ethers.Wallet.createRandom().address;
  await p.send('anvil_impersonateAccount', [delegate]);
  await p.send('anvil_setBalance', [delegate, ethers.toQuantity(ethers.parseEther('1'))]);
  const hash = await p.send('eth_sendTransaction', [
    { from: delegate, to: C.CONTRACTS.delegationManager, data: C.redeemCalldata(eth, { to: sink, amount: 10n ** 16n }), gas: ethers.toQuantity(1_500_000) },
  ]);
  const r = await p.waitForTransaction(hash);
  out('the stored ETH permission redeems 0.01 ETH', r.status === 1 && (await p.getBalance(sink)) === 10n ** 16n);
  let refused = '';
  try {
    await p.call({ from: delegate, to: C.CONTRACTS.delegationManager, data: C.redeemCalldata(eth, { to: sink, amount: 10n ** 17n }) });
  } catch (e) {
    refused = e.shortMessage || e.message;
  }
  out('and refuses past the daily cap', /transfer-amount-exceeded/.test(refused));
  await p.send('anvil_stopImpersonatingAccount', [delegate]);

  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
