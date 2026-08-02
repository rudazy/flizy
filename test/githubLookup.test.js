/**
 * GitHub login normalize + resolve (fetch mocked).
 * Run: node --test test/githubLookup.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeGitHubLogin, resolveGitHubUser } = require('../lib/githubLookup');

describe('normalizeGitHubLogin', () => {
  it('strips @ and validates shape', () => {
    assert.equal(normalizeGitHubLogin('@octocat'), 'octocat');
    assert.equal(normalizeGitHubLogin('  octocat  '), 'octocat');
    assert.equal(normalizeGitHubLogin('bad name'), '');
    assert.equal(normalizeGitHubLogin('-octocat'), '');
    assert.equal(normalizeGitHubLogin('a'.repeat(40)), '');
  });
});

describe('resolveGitHubUser', () => {
  it('returns id and login from GitHub JSON', async () => {
    const fetchMock = async () => ({
      status: 200,
      ok: true,
      json: async () => ({ id: 583231, login: 'octocat' }),
    });
    const profile = await resolveGitHubUser('octocat', { fetch: fetchMock });
    assert.deepEqual(profile, { id: '583231', login: 'octocat' });
  });

  it('returns null on 404', async () => {
    const fetchMock = async () => ({ status: 404, ok: false, json: async () => ({}) });
    assert.equal(await resolveGitHubUser('nobody-nope-xyz', { fetch: fetchMock }), null);
  });

  it('throws on rate limit', async () => {
    const fetchMock = async () => ({ status: 403, ok: false, json: async () => ({}) });
    await assert.rejects(() => resolveGitHubUser('octocat', { fetch: fetchMock }), /rate/i);
  });
});
