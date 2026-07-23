/**
 * Deploy Flizy DEX + FLZ on GIWA Sepolia via forge script.
 * Loads PRIVATE_KEY from root .env. Never prints the key.
 * Usage: node scripts/deploy-dex.js
 */
const { spawnSync } = require('child_process');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pk = process.env.PRIVATE_KEY || process.env.OPS_PRIVATE_KEY;
if (!pk) {
  console.error('Missing PRIVATE_KEY in .env');
  process.exit(1);
}

const treasury =
  process.env.FLIZY_TREASURY ||
  process.env.OPS_ADDRESS ||
  '0x81Fb7Ed21B9843D2D5C232A7F3e959F91993401B';

const rpc =
  process.env.GIWA_RPC ||
  process.env.CHAIN_GIWA_SEPOLIA_RPC ||
  'https://sepolia-rpc.giwa.io';

const forge = process.env.FORGE_PATH || 'C:\\Users\\Ludarep\\.foundry\\bin\\forge.exe';
const contractsDir = path.join(__dirname, '..', 'contracts');

// forge expects PRIVATE_KEY without 0x or with 0x depending on version; vm.envUint wants hex
let privateKey = pk.trim();
if (!privateKey.startsWith('0x')) privateKey = `0x${privateKey}`;

const env = {
  ...process.env,
  PRIVATE_KEY: privateKey,
  FLIZY_TREASURY: treasury,
  GIWA_RPC: rpc,
};

console.log('Deploying DEX to', rpc);
console.log('Treasury', treasury);
console.log('Forge', forge);

const args = [
  'script',
  'script/DeployDex.s.sol:DeployDex',
  '--rpc-url',
  rpc,
  '--broadcast',
  '--legacy',
  '-vvv',
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
