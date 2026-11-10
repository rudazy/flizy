/**
 * Paused features, for the bots. Mirror of web/lib/features.ts: the same
 * environment switches, the same default (hidden unless set to "on"), so a
 * feature is paused in chat exactly when it is paused on the site.
 * test/features.test.js keeps the two equal.
 *
 * Chat commands for what people already own (sending an NFT, claiming) keep
 * working whatever these say; only new activity and the help lines are gated.
 */

const FEATURE_ENV = Object.freeze({
  nftMarket: 'FEATURE_NFT_MARKET',
  nftMint: 'FEATURE_NFT_MINT',
  tasks: 'FEATURE_TASKS',
  projects: 'FEATURE_PROJECTS',
  tokenSocial: 'FEATURE_TOKEN_SOCIAL',
  follows: 'FEATURE_FOLLOWS',
});

const PAUSED_MESSAGE = 'This is paused on Flizy for now. Anything you already have still works.';

function featureOn(feature, env = process.env) {
  const key = FEATURE_ENV[feature];
  if (!key) throw new Error(`unknown feature: ${feature}`);
  return String(env[key] || '').trim().toLowerCase() === 'on';
}

module.exports = { FEATURE_ENV, PAUSED_MESSAGE, featureOn };
