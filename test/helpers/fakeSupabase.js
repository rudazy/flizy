/**
 * In-memory stand-in for the supabase-js query builder.
 *
 * Covers only what lib/identity.js uses: select/insert/update with eq/is/in,
 * limit, order, maybeSingle, single, and awaiting the builder directly.
 *
 * Database-side rules (the one-phone-one-account trigger, unique indexes) are
 * NOT simulated here. Tests against this fake prove the application guard; the
 * trigger in 20260725100000_channel_identities.sql is the second layer.
 */

let seq = 1;

function newId(prefix) {
  seq += 1;
  return `${prefix}-${String(seq).padStart(4, '0')}`;
}

class Query {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.filters = [];
    this.op = 'select';
    this.payload = null;
    this.limitN = null;
  }

  get rows() {
    if (!this.db.tables[this.table]) this.db.tables[this.table] = [];
    return this.db.tables[this.table];
  }

  select() {
    if (this.op === 'select') this.op = 'select';
    return this;
  }

  eq(col, value) {
    this.filters.push((r) => String(r[col] ?? '') === String(value ?? ''));
    return this;
  }

  is(col, value) {
    this.filters.push((r) => (r[col] ?? null) === value);
    return this;
  }

  in(col, values) {
    const list = (values || []).map((v) => String(v));
    this.filters.push((r) => list.includes(String(r[col] ?? '')));
    return this;
  }

  or() {
    return this;
  }

  order() {
    return this;
  }

  limit(n) {
    this.limitN = n;
    return this;
  }

  insert(row) {
    this.op = 'insert';
    this.payload = row;
    return this;
  }

  update(patch) {
    this.op = 'update';
    this.payload = patch;
    return this;
  }

  delete() {
    this.op = 'delete';
    return this;
  }

  matching() {
    return this.rows.filter((row) => this.filters.every((f) => f(row)));
  }

  /** Attach joined accounts row when the caller asked for accounts(*). */
  decorate(row) {
    if (!row) return row;
    if (this.table !== 'channel_identities') return row;
    const account = (this.db.tables.accounts || []).find((a) => a.id === row.account_id) || null;
    return { ...row, accounts: account };
  }

  run() {
    if (this.op === 'insert') {
      const rows = Array.isArray(this.payload) ? this.payload : [this.payload];
      const created = rows.map((row) => ({ id: newId(this.table), ...row }));
      this.rows.push(...created);
      return { data: created, error: null };
    }

    if (this.op === 'update') {
      const hits = this.matching();
      for (const row of hits) Object.assign(row, this.payload);
      return { data: hits, error: null };
    }

    if (this.op === 'delete') {
      const hits = this.matching();
      this.db.tables[this.table] = this.rows.filter((r) => !hits.includes(r));
      return { data: hits, error: null };
    }

    let hits = this.matching().map((r) => this.decorate(r));
    if (this.limitN != null) hits = hits.slice(0, this.limitN);
    return { data: hits, error: null };
  }

  async maybeSingle() {
    const { data, error } = this.run();
    if (error) return { data: null, error };
    return { data: data.length ? data[0] : null, error: null };
  }

  async single() {
    const { data, error } = this.run();
    if (error) return { data: null, error };
    if (!data.length) return { data: null, error: { message: 'no rows', code: 'PGRST116' } };
    return { data: data[0], error: null };
  }

  then(resolve, reject) {
    try {
      resolve(this.run());
    } catch (err) {
      if (reject) reject(err);
      else throw err;
    }
  }
}

/**
 * @param {Record<string, object[]>} [seed]
 */
function createFakeSupabase(seed = {}) {
  const db = { tables: { accounts: [], channel_identities: [], link_codes: [], users: [], ...seed } };
  return {
    db,
    client: {
      from(table) {
        return new Query(db, table);
      },
    },
  };
}

/** Install the fake as lib/supabase before lib/identity is required. */
function mockSupabaseModule(client) {
  const supabasePath = require.resolve('../../lib/supabase');
  require.cache[supabasePath] = {
    id: supabasePath,
    filename: supabasePath,
    loaded: true,
    exports: { getSupabase: () => client },
  };
}

module.exports = { createFakeSupabase, mockSupabaseModule };
