/**
 * Owner-mint Giwaforge tokens to a Flizy agent wallet (or any address).
 * Loads PRIVATE_KEY from root .env. Never prints the key.
 * Usage: node scripts/mint-giwaforge.js 0xAgentWallet 10
 */
const { spawnSync } = require('child_process');
const path = require('path');
const { ethers } = require('ethers');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const to = process.argv[2];
const count = Number(process.argv[3] || '10');
if (!to || !ethers.isAddress(to)) {
  console.error('Usage: node scripts/mint-giwaforge.js 0xAgentWallet 10');
  process.exit(1);
}
if (!Number.isInteger(count) || count < 1 || count > 50) {
  console.error('Count must be 1-50');
  process.exit(1);
}

const pk = process.env.PRIVATE_KEY || process.env.OPS_PRIVATE_KEY;
if (!pk) {
  console.error('Missing PRIVATE_KEY in .env');
  process.exit(1);
}

const rpc =
  process.env.GIWA_RPC ||
  process.env.CHAIN_GIWA_SEPOLIA_RPC ||
  'https://sepolia-rpc.giwa.io';
const collection =
  process.env.GIWAFORGE_ADDRESS || '0xa613FcF6FE09442391b07F87b82c24a539bCCB2A';

const forge = process.env.FORGE_PATH || 'C:\\Users\\Ludarep\\.foundry\\bin\\forge.exe';
const contractsDir = path.join(__dirname, '..', 'contracts');

let privateKey = pk.trim();
if (!privateKey.startsWith('0x')) privateKey = `0x${privateKey}`;

console.log('Minting', count, 'giwaforge to', ethers.getAddress(to));
console.log('Collection', collection);

const r = spawnSync(
  forge,
  [
    'script',
    'script/MintGiwaforge.s.sol:MintGiwaforge',
    '--rpc-url',
    rpc,
    '--broadcast',
    '--legacy',
    '-vv',
    '--sig',
    'run(address,address,uint256)',
    collection,
    ethers.getAddress(to),
    String(count),
  ],
  {
    cwd: contractsDir,
    env: { ...process.env, PRIVATE_KEY: privateKey, GIWA_RPC: rpc },
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  }
);

if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr) process.stderr.write(r.stderr);
process.exit(r.status === null ? 1 : r.status);
