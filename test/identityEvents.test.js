/**
 * The identity audit trail.
 *
 * Once money routes by username, this table is the only durable answer to "who
 * held this handle, and when did it move". It records outcomes rather than
 * actions, so a refusal leaves a row too: the interesting question during a
 * dispute is usually which bind was refused, not which succeeded.
 *
 * Every write happens inside the bind core, so no caller can forget one. These
 * tests assert the whole row for each outcome, not just that something was
 * logged.
 *
 * The append-only guarantee itself is a database trigger
 * (identity_events_no_update) and cannot be exercised against the in-memory
 * fake. Migration 20260802160000_identity_events.sql asserts the trigger exists
 * as its own post-condition, and refusing an UPDATE is proven when it is applied.
 *
 * Run: node --test test/identityEvents.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSupabase } = require('./helpers/fakeSupabase');
const {
  IDENTITY_EVENT,
  REBIND_POLICY,
  bindChannelIdentity,
  unlinkChannelIdentity,
} = require('../lib/channelBind');

const ACC_A = 'acc-a';
const ACC_B = 'acc-b';
const GH_ID = '583231';
const GH_OTHER = '999111';

let fake;

beforeEach(() => {
  fake = createFakeSupabase({
    accounts: [
      { id: ACC_A, display_name: 'A' },
      { id: ACC_B, display_name: 'B' },
    ],
    channel_identities: [],
    identity_events: [],
    identity_bind_attempts: [],
  });
});

function rows() {
  return (fake.db.tables.identity_events || []).map((e) => ({
    account_id: e.account_id,
    channel: e.channel,
    external_id: e.external_id,
    display_handle: e.display_handle,
    event_type: e.event_type,
  }));
}

const link = (accountId, externalId, displayHandle, rebindPolicy = REBIND_POLICY.REJECT) =>
  bindChannelIdentity(fake.client, {
    accountId,
    channel: 'github',
    externalId,
    displayHandle,
    rebindPolicy,
  });

describe('one row per outcome', () => {
  it('LINKED on a new bind', async () => {
    await link(ACC_A, GH_ID, 'jack');
    assert.deepEqual(rows(), [
      {
        account_id: ACC_A,
        channel: 'github',
        external_id: GH_ID,
        display_handle: 'jack',
        event_type: IDENTITY_EVENT.LINKED,
      },
    ]);
  });

  it('HANDLE_REFRESHED carries the new handle, not the old one', async () => {
    await link(ACC_A, GH_ID, 'jack');
    await link(ACC_A, GH_ID, 'renamed');
    assert.deepEqual(rows()[1], {
      account_id: ACC_A,
      channel: 'github',
      external_id: GH_ID,
      display_handle: 'renamed',
      event_type: IDENTITY_EVENT.HANDLE_REFRESHED,
    });
  });

  it('nothing at all when a relink changes nothing', async () => {
    await link(ACC_A, GH_ID, 'jack');
    await link(ACC_A, GH_ID, 'jack');
    assert.equal(rows().length, 1, 'an unchanged relink is not an event');
  });

  it('LINK_REJECTED_ALREADY_TAKEN names the account that was refused', async () => {
    await link(ACC_B, GH_ID, 'jack');
    await assert.rejects(() => link(ACC_A, GH_ID, 'jack'));

    const rejected = rows()[1];
    assert.equal(rejected.event_type, IDENTITY_EVENT.LINK_REJECTED_ALREADY_TAKEN);
    assert.equal(rejected.account_id, ACC_A, 'the refused account, not the owner');
    assert.equal(rejected.external_id, GH_ID);
  });

  it('LINK_REJECTED_ALREADY_LINKED names the identity that was refused', async () => {
    await link(ACC_A, GH_ID, 'jack');
    await assert.rejects(() => link(ACC_A, GH_OTHER, 'other'));

    const rejected = rows()[1];
    assert.equal(rejected.event_type, IDENTITY_EVENT.LINK_REJECTED_ALREADY_LINKED);
    assert.equal(rejected.account_id, ACC_A);
    assert.equal(rejected.external_id, GH_OTHER, 'the one that was turned away');
  });

  it('LINKED again when a move is allowed', async () => {
    await link(ACC_B, GH_ID, 'jack');
    await link(ACC_A, GH_ID, 'jack', REBIND_POLICY.MOVE);

    assert.equal(rows()[1].event_type, IDENTITY_EVENT.LINKED);
    assert.equal(rows()[1].account_id, ACC_A, 'the account it moved to');
  });

  it('UNLINKED keeps the handle it had, so the trail stays readable', async () => {
    await link(ACC_A, GH_ID, 'jack');
    await unlinkChannelIdentity(fake.client, { accountId: ACC_A, channel: 'github' });

    assert.deepEqual(rows()[1], {
      account_id: ACC_A,
      channel: 'github',
      external_id: GH_ID,
      display_handle: 'jack',
      event_type: IDENTITY_EVENT.UNLINKED,
    });
  });

  it('never logs anything for a caller that is locked out', async () => {
    fake.db.tables.identity_bind_attempts.push({
      account_id: ACC_A,
      failed_attempts: 9,
      locked_until: new Date(Date.now() + 60000).toISOString(),
    });
    await assert.rejects(() => link(ACC_A, GH_ID, 'jack'));
    assert.equal(rows().length, 0, 'a refusal above the lookup reveals nothing and records nothing');
  });
});

describe('the full trail of a handle changing hands', () => {
  it('reads in order', async () => {
    await link(ACC_A, GH_ID, 'jack');
    await assert.rejects(() => link(ACC_B, GH_ID, 'jack'));
    await unlinkChannelIdentity(fake.client, { accountId: ACC_A, channel: 'github' });
    await link(ACC_B, GH_ID, 'jack');

    assert.deepEqual(
      rows().map((r) => `${r.event_type}:${r.account_id}`),
      [
        `${IDENTITY_EVENT.LINKED}:${ACC_A}`,
        `${IDENTITY_EVENT.LINK_REJECTED_ALREADY_TAKEN}:${ACC_B}`,
        `${IDENTITY_EVENT.UNLINKED}:${ACC_A}`,
        `${IDENTITY_EVENT.LINKED}:${ACC_B}`,
      ],
      'refused, then released, then taken: the whole story is on the record'
    );
  });
});

describe('handles in the audit are already flattened', () => {
  it('stores a sanitized handle, so a log reader cannot be fooled by a newline', async () => {
    await link(ACC_A, GH_ID, 'jack\nLINKED: someone else');
    assert.ok(!rows()[0].display_handle.includes('\n'));
  });
});
