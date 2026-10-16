/**
 * Pin the Ammora venue: every contract Flizy's Ammora swap path touches, with
 * the keccak256 of its runtime code as read from GIWA Sepolia right now.
 *
 * Writes deployments/ammora-giwa-sepolia.json and the web copy
 * web/lib/generated/ammoraVenue.json (web/ cannot read root files on Vercel;
 * test/ammoraVenueDrift.test.js keeps the two identical).
 *
 * SELF-ATTESTED. Ammora publishes no reviewed release manifest for GIWA
 * Sepolia, and the SDK's built-in catalog fails its own attestation (no
 * runtime hash for the factory). So Flizy pins what it observed. The bot (at
 * boot) and the site (at runtime, and as a warning at build) check that each
 * address still has this code; on a mismatch the Ammora venue is off and
 * nothing else is affected. When Ammora publishes a signed manifest, it
 * replaces this file.
 *
 * Read-only: no transaction is sent. Run again only on purpose, and review the
 * diff: a changed hash means a changed contract.
 *
 * Usage: node scripts/ammora-pin.js
 */

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const CHAIN_ID = 91342;
const RPC = process.env.GIWA_RPC || 'https://sepolia-rpc.giwa.io';
const ROOT = path.join(__dirname, '..');
const OUT = [
  path.join(ROOT, 'deployments', 'ammora-giwa-sepolia.json'),
  path.join(ROOT, 'web', 'lib', 'generated', 'ammoraVenue.json'),
];

async function main() {
  const sdk = await import('@ammora-protocol/sdk');
  const rd = sdk.giwaSepoliaAutoRouteCatalog[CHAIN_ID];
  if (!rd) throw new Error('SDK has no GIWA Sepolia route catalog');
  const factory = rd.factories.find((f) => f.kind === 'dbc');
  if (!factory) throw new Error('SDK GIWA catalog has no dbc factory');

  /** role -> address, every contract the swap path calls or approves. */
  const roles = {
    aggregationRouter: rd.aggregationRouter,
    aggregationExecutionRegistry: rd.aggregationExecutionRegistry,
    alcAggregationAdapter: rd.alcAggregationAdapter,
    nativeRouter: rd.nativeRouter,
    executionRegistry: rd.executionRegistry,
    tokenPolicyRegistry: rd.tokenPolicyRegistry,
    dbcFactory: factory.address,
    dbcPoolImplementation: factory.execution.poolImplementation,
    wrappedNative: rd.wrappedNative,
  };

  const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== CHAIN_ID) throw new Error(`RPC is chain ${network.chainId}, not ${CHAIN_ID}`);
  const block = await provider.getBlockNumber();

  const contracts = {};
  for (const [role, raw] of Object.entries(roles)) {
    const address = ethers.getAddress(raw);
    const code = await provider.getCode(address, block);
    if (!code || code === '0x') throw new Error(`${role} ${address} has no code`);
    const sdkHash = rd.runtimeCodeHashes[address.toLowerCase()] || null;
    contracts[role] = { address, codeHash: ethers.keccak256(code), sdkCatalogHash: sdkHash };
  }

  const config = {
    schemaVersion: 1,
    attestation: 'self-attested',
    note:
      'Pinned by Flizy from the SDK built-in GIWA catalog and live chain reads (scripts/ammora-pin.js). Not signed by Ammora. Replace with Ammora\'s reviewed release manifest when one is published.',
    chainId: CHAIN_ID,
    // The package exports no ./package.json, so read it from disk.
    sdkVersion: JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', '@ammora-protocol', 'sdk', 'package.json'), 'utf8')).version,
    pinnedAtBlock: block,
    dbcFactoryStartBlock: String(factory.startBlock),
    /**
     * Contracts a prepared swap may target, or name as an approval spender.
     * Only the aggregation router: its swapExactInput calldata is decoded and
     * checked field by field (lib/ammora/venue.js checkPrepared). The native
     * router stays pinned and attested but is never a send target.
     */
    swapTargets: ['aggregationRouter'],
    contracts,
  };
  const text = JSON.stringify(config, null, 2) + '\n';
  for (const file of OUT) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    console.log('wrote', path.relative(ROOT, file));
  }
  for (const [role, c] of Object.entries(contracts)) {
    const vs = c.sdkCatalogHash == null ? 'no SDK hash' : c.sdkCatalogHash === c.codeHash ? 'matches SDK' : 'differs from SDK';
    console.log(`${role.padEnd(30)} ${c.address} ${vs}`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
