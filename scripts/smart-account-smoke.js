/**
 * Sepolia smoke for Kernel v3.3 (already on GIWA). RESEARCH ONLY.
 * Does not cut over the engine.
 *
 * CMD:
 *   node scripts\smart-account-smoke.js
 *   node scripts\smart-account-smoke.js --create
 *   node scripts\smart-account-smoke.js --fund 0.001
 *   node scripts\smart-account-smoke.js --send 0.0001 --to 0x...
 *
 * Default is read-only. Broadcast flags need PRIVATE_KEY (ops) in .env.
 * The sudo owner of this smoke account is that ops address. That is still
 * Flizy-held. Freeze / session-not-owner / take-control are not in this script.
 */

require('dotenv').config();
const { ethers } = require('ethers');
const { getDefaultChain, explorerTxUrl } = require('../lib/chains');
const {
  KERNEL_FACTORY,
  KERNEL_IMPLEMENTATION,
  ECDSA_VALIDATOR,
  ENTRY_POINT,
  encodeInitialize,
  encodeNativeSend,
  factoryContract,
  predictAccount,
  smokeSalt,
} = require('../lib/smartAccount');

const CREATE = process.argv.includes('--create');
const FUND_IDX = process.argv.indexOf('--fund');
const SEND_IDX = process.argv.indexOf('--send');
const TO_IDX = process.argv.indexOf('--to');

function argValue(idx) {
  if (idx < 0) return null;
  const v = process.argv[idx + 1];
  if (!v || v.startsWith('--')) return null;
  return v;
}

function explorerAddress(chain, address) {
  const base = (chain.explorerBaseUrl || '').replace(/\/$/, '');
  return `${base}/address/${address}`;
}

async function main() {
  const chain = getDefaultChain();
  const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId);
  const factory = factoryContract(provider);

  const implOnFactory = await factory.implementation();
  if (ethers.getAddress(implOnFactory) !== KERNEL_IMPLEMENTATION) {
    throw new Error(
      `factory implementation ${implOnFactory} != pinned ${KERNEL_IMPLEMENTATION}`
    );
  }

  const needsSigner = CREATE || FUND_IDX >= 0 || SEND_IDX >= 0;
  let signer = null;
  if (needsSigner) {
    const pk = process.env.PRIVATE_KEY;
    if (!pk) throw new Error('PRIVATE_KEY missing in .env (ops key for this smoke)');
    signer = new ethers.Wallet(pk, provider);
  }

  const sudo = signer
    ? signer.address
    : process.env.SMOKE_SUDO || (process.env.PRIVATE_KEY
        ? new ethers.Wallet(process.env.PRIVATE_KEY).address
        : null);

  if (!sudo) {
    console.log('Set PRIVATE_KEY or SMOKE_SUDO to predict the account address.');
    console.log('Factory   ', KERNEL_FACTORY);
    console.log('Kernel    ', KERNEL_IMPLEMENTATION);
    console.log('ECDSA     ', ECDSA_VALIDATOR);
    console.log('EntryPoint', ENTRY_POINT);
    return;
  }

  const initData = encodeInitialize(sudo);
  const salt = smokeSalt();
  const account = await predictAccount(provider, initData, salt);
  const code = await provider.getCode(account);
  const deployed = code !== '0x';
  const bal = await provider.getBalance(account);

  console.log('');
  console.log('Flizy Kernel smoke  (read-only unless --create / --fund / --send)');
  console.log(`Chain:     ${chain.name} (${chain.chainId})`);
  console.log(`Sudo EOA:  ${sudo}`);
  console.log(`Account:   ${account}`);
  console.log(`Deployed:  ${deployed ? 'yes' : 'no'}`);
  console.log(`Balance:   ${ethers.formatEther(bal)} ETH`);
  console.log(`Explorer:  ${explorerAddress(chain, account)}`);
  console.log('');

  if (!needsSigner) {
    console.log('Create:  node scripts\\smart-account-smoke.js --create');
    console.log('Fund:    node scripts\\smart-account-smoke.js --fund 0.001');
    console.log('Send:    node scripts\\smart-account-smoke.js --send 0.0001 --to 0x...');
    return;
  }

  if (CREATE) {
    if (deployed) {
      console.log('Already created. Skip --create.');
    } else {
      const tx = await factory.connect(signer).createAccount(initData, salt);
      const rec = await tx.wait(1);
      if (!rec || rec.status !== 1) throw new Error('createAccount failed');
      console.log(`create tx ${explorerTxUrl(chain, tx.hash)}`);
    }
  }

  const fundAmt = argValue(FUND_IDX);
  if (fundAmt) {
    const value = ethers.parseEther(fundAmt);
    const tx = await signer.sendTransaction({ to: account, value });
    const rec = await tx.wait(1);
    if (!rec || rec.status !== 1) throw new Error('fund failed');
    console.log(`fund  ${fundAmt} ETH  ${explorerTxUrl(chain, tx.hash)}`);
  }

  const sendAmt = argValue(SEND_IDX);
  if (sendAmt) {
    const to = argValue(TO_IDX);
    if (!to || !ethers.isAddress(to)) throw new Error('--send requires --to 0x...');
    const value = ethers.parseEther(sendAmt);
    const data = encodeNativeSend(to, value);
    const tx = await signer.sendTransaction({ to: account, data });
    const rec = await tx.wait(1);
    if (!rec || rec.status !== 1) throw new Error('execute send failed');
    console.log(`send   ${sendAmt} ETH to ${ethers.getAddress(to)}`);
    console.log(`       ${explorerTxUrl(chain, tx.hash)}`);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
