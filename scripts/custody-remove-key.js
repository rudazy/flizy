/**
 * Recovery: take one passkey off a Flizy account's HybridDeleGator.
 *
 * For when a passkey added through Secure your wallet must come off (a lost
 * device, a bad add). Flizy is still the account's owner during the pilot, so
 * the owner key runs removeKey on the account itself, the same way addKey was
 * run. Every permission that passkey signed stops working at once: the
 * DelegationManager asks the account to check the signature on each spend, and
 * the account no longer holds the key.
 *
 * It only ever encodes removeKey. It never calls transferOwnership or
 * renounceOwnership, and it checks the owner is unchanged afterwards.
 *
 * Without --confirm it is a dry run: it prints the owner and the keys and
 * sends nothing. The key id is the custody_passkeys.key_id of that passkey:
 *   select key_id from public.custody_passkeys where account_id = '<id>' and status = 'added';
 *
 * It does not change the database. After a removal, mark the rows yourself:
 *   update public.custody_passkeys set status = 'failed' where key_id = '<key id>';
 *   update public.custody_delegations set status = 'revoked' where account_id = '<id>' and status = 'active';
 *
 * Run (Windows CMD), dry run first:
 *   node scripts\custody-remove-key.js --account 0x... --account-id <uuid> --key-id <id>
 *   node scripts\custody-remove-key.js --account 0x... --account-id <uuid> --key-id <id> --confirm
 * Optional: --rpc <url> (default GIWA_RPC, then the public GIWA Sepolia endpoint).
 */

require('dotenv').config({ quiet: true });
const path = require('path');
const { ethers } = require('ethers');

const CHAIN_ID = 91342n;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_ID_RE = /^[A-Za-z0-9_-]{16,1366}$/;

/** The only write this script can encode. */
const REMOVE = new ethers.Interface(['function removeKey(string _keyId)']);
const READ = new ethers.Interface([
  'function owner() view returns (address)',
  'function getKeyIdHashes() view returns (bytes32[])',
  'function getKey(string _keyId) view returns (uint256 x_, uint256 y_)',
]);

function parseArgs(argv) {
  const out = { confirm: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--confirm') out.confirm = true;
    else if (['--account', '--account-id', '--key-id', '--rpc'].includes(a)) {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${a} needs a value`);
      out[a.slice(2).replace(/-(.)/g, (_, c) => c.toUpperCase())] = value;
      i += 1;
    } else throw new Error(`unknown argument ${a}`);
  }
  if (!out.account || !ethers.isAddress(out.account)) throw new Error('--account must be the wallet address (0x...)');
  if (!out.accountId || !UUID_RE.test(out.accountId)) throw new Error('--account-id must be the account id (uuid)');
  if (!out.keyId || !KEY_ID_RE.test(out.keyId)) throw new Error('--key-id must be the passkey key id from custody_passkeys');
  out.account = ethers.getAddress(out.account);
  return out;
}

function removeKeyCalldata(keyId) {
  return REMOVE.encodeFunctionData('removeKey', [keyId]);
}

async function readState(provider, account, keyId) {
  const call = async (fn, args = []) => READ.decodeFunctionResult(fn, await provider.call({ to: account, data: READ.encodeFunctionData(fn, args) }));
  const [owner] = await call('owner');
  const [hashes] = await call('getKeyIdHashes');
  const [x, y] = await call('getKey', [keyId]);
  return { owner, hashes: [...hashes], holdsKey: x !== 0n || y !== 0n };
}

function printState(label, s, keyHash) {
  console.log(`${label}`);
  console.log(`  owner : ${s.owner}`);
  console.log(`  keys  : ${s.hashes.length}`);
  for (const h of s.hashes) console.log(`          ${h}${h === keyHash ? '  <- this passkey' : ''}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { predictGatorAddress } = require('../lib/gatorAccount');
  const { deriveAgentWallet } = require('../lib/agentWallet');
  const { executeGatorCall, outcomeUnknown } = require('../lib/gatorExecute');

  if (predictGatorAddress(args.accountId) !== args.account) {
    throw new Error('that account id does not own this wallet address; check both');
  }
  const rpc = args.rpc || process.env.GIWA_RPC || 'https://sepolia-rpc.giwa.io';
  const provider = new ethers.JsonRpcProvider(rpc);
  const { chainId } = await provider.getNetwork();
  if (chainId !== CHAIN_ID) throw new Error(`expected GIWA Sepolia (91342), the RPC is on ${chainId}`);
  console.log(`rpc     : ${new URL(rpc).host}`);
  console.log(`account : ${args.account}`);

  const keyHash = ethers.keccak256(ethers.toUtf8Bytes(args.keyId));
  const before = await readState(provider, args.account, args.keyId);
  printState('before', before, keyHash);

  if (!before.holdsKey || !before.hashes.includes(keyHash)) throw new Error('that passkey is not on this account; nothing to remove');
  const flizyOwner = deriveAgentWallet(args.accountId).address;
  if (before.owner !== flizyOwner) {
    throw new Error(`the owner is not Flizy's key for this account (${flizyOwner}); this script cannot act and must not try`);
  }

  if (!args.confirm) {
    console.log('\nDry run. Nothing was sent. Add --confirm to remove this passkey.');
    return;
  }

  const data = removeKeyCalldata(args.keyId);
  if (data.slice(0, 10) !== REMOVE.getFunction('removeKey').selector) throw new Error('refusing: calldata is not removeKey');
  console.log('\nsending removeKey ...');
  let sent;
  try {
    sent = await executeGatorCall({
      accountId: args.accountId,
      provider,
      chainId: Number(CHAIN_ID),
      target: args.account,
      value: 0n,
      data,
      onBroadcast: (hash) => console.log(`  tx    : ${hash}`),
    });
  } catch (err) {
    if (outcomeUnknown(err)) {
      // Sent, not confirmed: it may still land. Never report that as refused.
      console.log('  status: sent, not confirmed yet. Run the dry run again in a minute to see whether the key is gone.');
      process.exitCode = 2;
      return;
    }
    throw err;
  }
  console.log(`  status: confirmed in block ${sent.receipt.blockNumber}`);

  const after = await readState(provider, args.account, args.keyId);
  printState('after', after, keyHash);
  if (after.owner !== before.owner) throw new Error('the owner changed; stop and investigate');
  if (after.holdsKey || after.hashes.includes(keyHash)) throw new Error('the passkey is still on the account');
  console.log('\nThe passkey is off. Permissions it signed no longer pass. Mark the database rows (see the header of this file).');
}

const isMain = path.resolve(process.argv[1] || '') === __filename;
if (isMain) {
  main().catch((err) => {
    console.error(`refused: ${err.shortMessage || err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, removeKeyCalldata };
