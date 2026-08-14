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

/** -1, 0 or 1. Numeric when both sides are numbers, string order otherwise. */
function compare(left, right) {
  const a = left ?? '';
  const b = right ?? '';
  const na = Number(a);
  const nb = Number(b);
  if (a !== '' && b !== '' && Number.isFinite(na) && Number.isFinite(nb)) {
    return na === nb ? 0 : na < nb ? -1 : 1;
  }
  const sa = String(a);
  const sb = String(b);
  return sa === sb ? 0 : sa < sb ? -1 : 1;
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

  ilike(col, value) {
    const needle = String(value ?? '').toLowerCase();
    this.filters.push((r) => String(r[col] ?? '').toLowerCase() === needle);
    return this;
  }

  /**
   * Range filters. Numbers compare numerically, everything else as strings,
   * which is the right answer for the ISO timestamps these are used on.
   */
  gte(col, value) {
    this.filters.push((r) => compare(r[col], value) >= 0);
    return this;
  }

  gt(col, value) {
    this.filters.push((r) => compare(r[col], value) > 0);
    return this;
  }

  lte(col, value) {
    this.filters.push((r) => compare(r[col], value) <= 0);
    return this;
  }

  lt(col, value) {
    this.filters.push((r) => compare(r[col], value) < 0);
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

  /**
   * PostgREST upsert semantics, which the session code depends on: on a
   * conflict only the columns present in the payload are written, so a column
   * the caller did not name keeps its value. A fake that replaced the whole row
   * would hide exactly the bug lib/session.js relies on not having.
   */
  upsert(row, options = {}) {
    this.op = 'upsert';
    this.payload = row;
    this.conflictCols = String(options.onConflict || 'id')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
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

    if (this.op === 'upsert') {
      const rows = Array.isArray(this.payload) ? this.payload : [this.payload];
      const out = [];
      for (const row of rows) {
        const existing = this.rows.find((r) =>
          this.conflictCols.every((c) => String(r[c] ?? '') === String(row[c] ?? ''))
        );
        if (existing) {
          Object.assign(existing, row);
          out.push(existing);
        } else {
          const created = { id: newId(this.table), ...row };
          this.rows.push(created);
          out.push(created);
        }
      }
      return { data: out, error: null };
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

  /**
   * Stand-ins for the Postgres functions in
   * 20260729110000_atomic_balance_debit.sql.
   *
   * The point of those functions is that the read, the guard and the write are
   * one statement, so a concurrent caller cannot slip in between. These bodies
   * are synchronous for the same reason: nothing may await partway through, or
   * the fake would be more forgiving than the database and the concurrency
   * tests would prove nothing.
   */
  const rpcs = {
    debit_user_balance({ p_user_id, p_amount }) {
      const amount = Number(p_amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return { data: null, error: { message: 'debit amount must be greater than 0' } };
      }
      const row = (db.tables.users || []).find((u) => String(u.id) === String(p_user_id));
      if (!row) return { data: [{ success: false, new_balance: 0 }], error: null };

      const balance = Number(row.balance_eth || 0);
      if (balance < amount) {
        return { data: [{ success: false, new_balance: balance }], error: null };
      }
      row.balance_eth = balance - amount;
      return { data: [{ success: true, new_balance: row.balance_eth }], error: null };
    },

    credit_user_balance({ p_user_id, p_amount }) {
      const amount = Number(p_amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return { data: null, error: { message: 'credit amount must be greater than 0' } };
      }
      const row = (db.tables.users || []).find((u) => String(u.id) === String(p_user_id));
      if (!row) return { data: [{ success: false, new_balance: 0 }], error: null };

      row.balance_eth = Number(row.balance_eth || 0) + amount;
      return { data: [{ success: true, new_balance: row.balance_eth }], error: null };
    },
  };

  return {
    db,
    client: {
      from(table) {
        return new Query(db, table);
      },
      async rpc(name, args) {
        const fn = rpcs[name];
        if (!fn) return { data: null, error: { message: `unknown function ${name}` } };
        return fn(args || {});
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
