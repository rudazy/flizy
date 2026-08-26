/**
 * Deploy Giwaforge ERC-721 on GIWA Sepolia via forge script.
 * Loads PRIVATE_KEY from root .env. Never prints the key.
 * Optional NFT_MINT_TO: first 20 tokens go there instead of the deployer.
 * Usage: node scripts/deploy-giwaforge.js
 */
const { spawnSync } = require('child_process');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pk = process.env.PRIVATE_KEY || process.env.OPS_PRIVATE_KEY;
if (!pk) {
  console.error('Missing PRIVATE_KEY in .env');
  process.exit(1);
}

const rpc =
  process.env.GIWA_RPC ||
  process.env.CHAIN_GIWA_SEPOLIA_RPC ||
  'https://sepolia-rpc.giwa.io';

const forge = process.env.FORGE_PATH || 'C:\\Users\\Ludarep\\.foundry\\bin\\forge.exe';
const contractsDir = path.join(__dirname, '..', 'contracts');

let privateKey = pk.trim();
if (!privateKey.startsWith('0x')) privateKey = `0x${privateKey}`;

const env = {
  ...process.env,
  PRIVATE_KEY: privateKey,
  GIWA_RPC: rpc,
};

if (process.env.NFT_MINT_TO) env.NFT_MINT_TO = process.env.NFT_MINT_TO.trim();

console.log('Deploying Giwaforge to', rpc);
console.log('Forge', forge);
if (env.NFT_MINT_TO) console.log('First batch mint to', env.NFT_MINT_TO);

const args = [
  'script',
  'script/DeployGiwaforge.s.sol:DeployGiwaforge',
  '--rpc-url',
  rpc,
  '--broadcast',
  '--legacy',
  '-vv',
];

const r = spawnSync(forge, args, {
  cwd: contractsDir,
  env,
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
});

if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr) process.stderr.write(r.stderr);
process.exit(r.status === null ? 1 : r.status);
