/**
 * Renders spikes/privy-owner/RESULTS.md from state.json after every step.
 * Public data only: addresses, transaction hashes, magic values, reverts.
 */

const fs = require('fs');
const path = require('path');
const C = require('./chain.cjs');

const RESULTS_FILE = path.join(C.SPIKE_DIR, 'RESULTS.md');

const TITLES = {
  S1: 'Privy wallet signs a message and an EIP-712 payload',
  S2: 'Throwaway gator owned by a throwaway EOA, funded with ETH and FLZ',
  S3: 'Ownership moves to the Privy wallet; the old owner signature is rejected',
  S4: 'Privy wallet signs the delegations; ERC-1271 returns the magic value',
  S5: 'Redemption: in-bounds ETH, out-of-bounds ETH, FLZ',
  S6: 'Revoke',
  S7: 'Owner exit',
  S8: 'Gator address stable throughout',
  S9: 'Guest MetaMask wallet through Privy does a self-transfer',
};

function render(state) {
  const ids = Object.keys(TITLES);
  const failed = ids.filter((id) => state.steps[id] && state.steps[id].status !== 'PASS');
  // A step the runner says it does not cover is reported as not covered, not as pending.
  const skipped = state.coverage ? ['S9'] : [];
  const pending = ids.filter((id) => !state.steps[id] && !skipped.includes(id));
  const verdict = failed.length === 0 && pending.length === 0 ? 'PASS' : failed.length ? 'FAIL' : 'INCOMPLETE';

  const lines = [
    '# Privy as HybridDeleGator owner on GIWA Sepolia',
    '',
    `Verdict: **${verdict}**. Failed steps: ${failed.length ? failed.join(', ') : 'none'}.${pending.length ? ` Not yet run: ${pending.join(', ')}.` : ''}${skipped.length ? ` Not covered: ${skipped.join(', ')} and the browser login.` : ''}`,
    '',
    `Chain ${C.CHAIN_ID}, explorer ${C.EXPLORER}. MetaMask delegation-framework v1.3.0 (commit bfbdf97),`,
    'contracts from deployments/giwa-sepolia-delegation.json. Throwaway accounts and testnet amounts only.',
    'Transaction hashes open at the explorer under /tx/<hash>. Generated from state.json by server/results.cjs.',
    '',
    ...(state.coverage
      ? [
          '## Coverage',
          '',
          `Runner: ${state.coverage.runner}.`,
          `Privy wallet: ${state.coverage.privyWallet}.`,
          '',
          '**Not covered by this run:**',
          '',
          ...state.coverage.notCovered.map((x) => `- ${x}`),
          '',
        ]
      : []),
    '## Accounts',
    '',
    `- Gator: ${state.gator ? state.gator.address : 'not deployed'}`,
    `- Original owner (throwaway EOA): ${state.roles ? state.roles.owner : '-'}`,
    `- Privy wallet (new owner): ${state.privy ? `${state.privy.address} (${state.privy.walletClientType || 'unknown type'})` : '-'}`,
    `- Flizy stand-in delegate: ${state.roles ? state.roles.delegate : '-'}`,
    `- Relayer and funder: ${state.roles ? state.roles.funder : '-'}`,
    `- Sink: ${state.sink || '-'}`,
    `- ERC20TransferAmountEnforcer (deployed for this spike): ${state.erc20Enforcer ? state.erc20Enforcer.address : '-'}`,
    '',
    '## Steps',
    '',
    '| Step | What | Result |',
    '| --- | --- | --- |',
    ...ids.map((id) => `| ${id} | ${TITLES[id]} | ${state.steps[id] ? state.steps[id].status : skipped.includes(id) ? 'not covered' : 'not run'} |`),
    '',
  ];

  for (const id of ids) {
    const step = state.steps[id];
    if (!step) continue;
    lines.push(`### ${id}: ${TITLES[id]}`, '', `Status: ${step.status}, at ${step.at}.`, '', '```json', JSON.stringify(step, null, 2), '```', '');
  }
  return `${lines.join('\n')}`;
}

function writeResults(state) {
  fs.writeFileSync(RESULTS_FILE, render(state));
}

module.exports = { writeResults };
