/**
 * Finding the claims that belong to you, across both addressing modes.
 *
 * listIncomingPending runs one query per mode and merges. The risk in that
 * shape is over-matching: the platform query filters channel and id as two
 * separate sets, so it can return a claim whose channel and id came from
 * different identities. The exact (channel, id) matcher runs over the result
 * for that reason, and these tests are what prove it does.
 *
 * Run: node --test test/claimPlatformMatch.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');

let fake = createFakeSupabase();
mockSupabaseModule({ from: (table) => fake.client.from(table) });

const { listIncomingPending } = require('../lib/claims');

const PHONE = '2348012345678';
const OTHER_PHONE = '2348099999999';
const GH_ID = '583231';
const X_ID = '12345678';

const claims = [
  {
    id: 'c-phone',
    status: 'pending',
    amount_eth: '0.001',
    created_at: '2026-08-01T10:00:00Z',
    to_wa_hint: PHONE,
    to_channel: null,
    to_external_id: null,
  },
  {
    id: 'c-phone-other',
    status: 'pending',
    amount_eth: '0.002',
    created_at: '2026-08-01T11:00:00Z',
    to_wa_hint: OTHER_PHONE,
    to_channel: null,
    to_external_id: null,
  },
  {
    id: 'c-github',
    status: 'pending',
    amount_eth: '0.003',
    created_at: '2026-08-01T12:00:00Z',
    to_wa_hint: null,
    to_channel: 'github',
    to_external_id: GH_ID,
    to_display_handle: 'jack',
  },
  {
    // Same digits as the github claim, different platform, different person.
    id: 'c-x-same-digits',
    status: 'pending',
    amount_eth: '0.004',
    created_at: '2026-08-01T13:00:00Z',
    to_wa_hint: null,
    to_channel: 'x',
    to_external_id: GH_ID,
    to_display_handle: 'someone_else',
  },
  {
    id: 'c-claimed',
    status: 'claimed',
    amount_eth: '0.005',
    created_at: '2026-08-01T09:00:00Z',
    to_wa_hint: null,
    to_channel: 'github',
    to_external_id: GH_ID,
  },
];

function seed() {
  fake = createFakeSupabase({ claims: claims.map((c) => ({ ...c })) });
}

function ids(rows) {
  return rows.map((r) => r.id).sort();
}

describe('listIncomingPending', () => {
  beforeEach(seed);

  it('finds a phone claim for a proven phone', async () => {
    const rows = await listIncomingPending({ waPhone: PHONE });
    assert.deepEqual(ids(rows), ['c-phone']);
  });

  it('finds a platform claim for a proven platform identity', async () => {
    const rows = await listIncomingPending({
      identities: [{ channel: 'github', external_id: GH_ID }],
    });
    assert.deepEqual(ids(rows), ['c-github']);
  });

  it('does not hand over the same id on another platform', async () => {
    // c-x-same-digits carries the identical external id on x. Filtering the two
    // columns independently pulls it back from the database, so the exact
    // matcher has to be what excludes it.
    const rows = await listIncomingPending({
      identities: [{ channel: 'github', external_id: GH_ID }],
    });
    assert.ok(
      !rows.some((r) => r.id === 'c-x-same-digits'),
      'an x claim must never be handed to a github identity'
    );
  });

  it('returns both modes at once for an account that has proven both', async () => {
    const rows = await listIncomingPending({
      waPhone: PHONE,
      identities: [{ channel: 'github', external_id: GH_ID }],
    });
    assert.deepEqual(ids(rows), ['c-github', 'c-phone']);
  });

  it('never returns a claim that is not pending', async () => {
    const rows = await listIncomingPending({
      identities: [{ channel: 'github', external_id: GH_ID }],
    });
    assert.ok(!rows.some((r) => r.id === 'c-claimed'));
  });

  it('returns nothing when no identity is proven', async () => {
    assert.deepEqual(await listIncomingPending({}), []);
    assert.deepEqual(await listIncomingPending({ identities: [] }), []);
  });

  it('ignores an identity on a channel it cannot name', async () => {
    const rows = await listIncomingPending({
      identities: [{ channel: 'signal', external_id: GH_ID }],
    });
    assert.deepEqual(rows, []);
  });

  it('does not let a platform identity collect a phone claim', async () => {
    // The phone digits as a platform id. Different mode, so no match.
    const rows = await listIncomingPending({
      identities: [{ channel: 'github', external_id: PHONE }],
    });
    assert.deepEqual(rows, []);
  });

  it('deduplicates rather than listing a claim twice', async () => {
    const rows = await listIncomingPending({
      waPhone: PHONE,
      identities: [
        { channel: 'github', external_id: GH_ID },
        { channel: 'github', external_id: GH_ID },
      ],
    });
    assert.equal(rows.length, new Set(rows.map((r) => r.id)).size);
  });

  it('orders newest first across the merge', async () => {
    const rows = await listIncomingPending({
      waPhone: PHONE,
      identities: [{ channel: 'x', external_id: GH_ID }],
    });
    assert.deepEqual(
      rows.map((r) => r.id),
      ['c-x-same-digits', 'c-phone'],
      'the newer x claim sorts above the older phone claim'
    );
  });

  it('finds claims on several platforms at once', async () => {
    fake = createFakeSupabase({
      claims: [
        { ...claims[2] },
        {
          id: 'c-x-mine',
          status: 'pending',
          amount_eth: '0.006',
          created_at: '2026-08-01T14:00:00Z',
          to_wa_hint: null,
          to_channel: 'x',
          to_external_id: X_ID,
        },
      ],
    });

    const rows = await listIncomingPending({
      identities: [
        { channel: 'github', external_id: GH_ID },
        { channel: 'x', external_id: X_ID },
      ],
    });
    assert.deepEqual(ids(rows), ['c-github', 'c-x-mine']);
  });
});
