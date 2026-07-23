/**
 * Step 0: inspect GIWA Sepolia for deploy wallet balance and known DEX env.
 * Usage: node scripts/check-giwa-dex.js
 */
require('dotenv').config();
const { ethers } = require('ethers');

async function main() {
  const rpc =
    process.env.GIWA_RPC ||
    process.env.CHAIN_GIWA_SEPOLIA_RPC ||
    'https://sepolia-rpc.giwa.io';
  const p = new ethers.JsonRpcProvider(rpc);
  const n = await p.getNetwork();
  console.log('chainId', n.chainId.toString());
  console.log('rpc', rpc);

  const ops = '0x81Fb7Ed21B9843D2D5C232A7F3e959F91993401B';
  const bal = await p.getBalance(ops);
  console.log('opsAddress', ops);
  console.log('opsBalEth', ethers.formatEther(bal));

  console.log('env.WETH', process.env.CHAIN_GIWA_SEPOLIA_WETH || '(empty)');
  console.log('env.ROUTER', process.env.CHAIN_GIWA_SEPOLIA_DEX_ROUTER || '(empty)');
  console.log('env.FACTORY', process.env.CHAIN_GIWA_SEPOLIA_DEX_FACTORY || '(empty)');

  const pk = process.env.PRIVATE_KEY || process.env.OPS_PRIVATE_KEY || '';
  if (pk) {
    const w = new ethers.Wallet(pk);
    console.log('deployKeyAddress', w.address);
    console.log('deployKeyMatchesOps', w.address.toLowerCase() === ops.toLowerCase());
    const kb = await p.getBalance(w.address);
    console.log('deployKeyBalEth', ethers.formatEther(kb));
  } else {
    console.log('deployKey', 'MISSING');
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
