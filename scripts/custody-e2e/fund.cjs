/**
 * Funds the throwaway wallet and the ops key on the local GIWA fork, and picks a
 * random relayer address for the run (delegate.txt, gitignored). Fork only:
 * it refuses anything that does not answer anvil's own RPC methods.
 *
 * Run: node scripts/custody-e2e/fund.cjs   (FORK_RPC defaults to http://127.0.0.1:8546)
 */

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const ROOT = path.resolve(__dirname, '..', '..');
const RPC = process.env.FORK_RPC || 'http://127.0.0.1:8546';

(async () => {
  if (!['127.0.0.1', 'localhost'].includes(new URL(RPC).hostname)) throw new Error('FORK_RPC must be a local anvil fork');
  const state = JSON.parse(fs.readFileSync(path.join(__dirname, 'state.json'), 'utf8'));
  const env = require('dotenv').parse(fs.readFileSync(path.join(ROOT, 'web', '.env.local')));
  const ops = new ethers.Wallet(env.PRIVATE_KEY).address;
  const p = new ethers.JsonRpcProvider(RPC);
  await p.send('anvil_nodeInfo', []);
  for (const addr of [state.gator, ops]) await p.send('anvil_setBalance', [addr, ethers.toQuantity(ethers.parseEther('5'))]);
  const delegate = ethers.Wallet.createRandom().address;
  fs.writeFileSync(path.join(__dirname, 'delegate.txt'), delegate);
  console.log('fork funded; relayer for this run', delegate);
})().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
