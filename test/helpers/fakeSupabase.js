/**
 * In-memory stand-in for the supabase-js query builder.
 *
 * Covers what the app actually calls: select, insert, update, upsert and delete;
 * the filters eq, is, in, ilike, gt, gte, lt, lte and not; limit, order (a
 * no-op), maybeSingle, single, `select(cols, { count, head })`, and awaiting the
 * builder directly.
 *
 * Database-side rules are NOT simulated: no triggers, no CHECK constraints, no
 * unique indexes, and therefore no unique-violation races. Tests against this
 * fake prove the application guard only. The second layer is the schema itself
 * (triggers, indexes, constraints), and that has to be proven against a real
 * development database, not here.
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
    this.countMode = null;
    this.headOnly = false;
  }

  get rows() {
    if (!this.db.tables[this.table]) this.db.tables[this.table] = [];
    return this.db.tables[this.table];
  }

  /**
   * `select(cols, { count, head })`.
   *
   * Columns are ignored, as they always were: this fake returns whole rows and
   * the code under test reads the fields it asked for. The options are not
   * ignored, because `{ count: 'exact', head: true }` is how the real client is
   * asked "how many", and code that numbers a row from that count would other-
   * wise see undefined here and take a branch production never takes.
   */
  select(_cols, opts) {
    if (this.op === 'select') this.op = 'select';
    if (opts && opts.count) this.countMode = String(opts.count);
    if (opts && opts.head) this.headOnly = true;
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

  /**
   * PostgREST .not(column, operator, value). Only the operators the app uses
   * are implemented; anything else throws rather than filtering nothing, so a
   * new call site fails loudly here instead of silently matching every row.
   */
  not(col, op, value) {
    const operator = String(op || '').toLowerCase();
    if (operator === 'is') {
      this.filters.push((r) => (r[col] ?? null) !== value);
      return this;
    }
    if (operator === 'eq') {
      this.filters.push((r) => String(r[col] ?? '') !== String(value ?? ''));
      return this;
    }
    if (operator === 'in') {
      const list = (value || []).map((v) => String(v));
      this.filters.push((r) => !list.includes(String(r[col] ?? '')));
      return this;
    }
    throw new Error(`fakeSupabase: .not(${col}, ${op}) is not implemented`);
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
      const created = rows.map((row) => {
        const made = { id: newId(this.table), ...row };
        // Fill a sequence column the database would have filled.
        const col = this.db.sequences[this.table];
        if (col && made[col] == null) {
          const next = (this.db.nextSeq[this.table] || 99) + 1;
          this.db.nextSeq[this.table] = next;
          made[col] = next;
        }
        return made;
      });
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
    // head:true means the caller wants the count and no rows, which is what the
    // real client returns: data is null, not an empty array.
    if (this.countMode) {
      return { data: this.headOnly ? null : hits, error: null, count: this.matching().length };
    }
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
/**
 * @param {object} [seed] starting rows, keyed by table
 * @param {{ sequences?: Record<string, string> }} [opts]
 *   sequences maps a table to a column filled by a Postgres sequence, e.g.
 *   { tasks: 'ref' }. Opt-in and explicit: a default the database supplies is
 *   invisible to this fake, and a test whose ids all come back undefined fails
 *   for a reason that has nothing to do with what it was checking.
 */
function createFakeSupabase(seed = {}, opts = {}) {
  const db = {
    tables: { accounts: [], channel_identities: [], link_codes: [], users: [], ...seed },
    sequences: { ...(opts.sequences || {}) },
    nextSeq: {},
  };

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

    /**
     * 20260827000000_account_tx_locks.sql. One in-flight money move per
     * account: the insert is the lock, and a stale row older than the timeout
     * is cleared first so a crashed request cannot freeze the account.
     */
    try_account_tx_lock({ p_account_id, p_kind }) {
      if (!p_account_id) return { data: false, error: null };
      if (!db.tables.account_tx_locks) db.tables.account_tx_locks = [];
      const rows = db.tables.account_tx_locks;
      const staleBefore = Date.now() - 2 * 60 * 1000;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (new Date(rows[i].created_at).getTime() < staleBefore) rows.splice(i, 1);
      }
      if (rows.some((r) => String(r.account_id) === String(p_account_id))) {
        return { data: false, error: null };
      }
      rows.push({
        account_id: String(p_account_id),
        kind: String(p_kind || 'tx').trim() || 'tx',
        created_at: new Date().toISOString(),
      });
      return { data: true, error: null };
    },

    release_account_tx_lock({ p_account_id }) {
      const rows = db.tables.account_tx_locks || [];
      const i = rows.findIndex((r) => String(r.account_id) === String(p_account_id));
      if (i >= 0) rows.splice(i, 1);
      return { data: null, error: null };
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

    /**
     * 20260930120000_daily_native_sent.sql: native ETH sent today (UTC) by one
     * account. Outgoing non-swap transfers plus claim holds, native rows only.
     * Summed as 18-decimal fixed point, as the numeric column is, and returned
     * as text like the function.
     */
    daily_native_sent_eth({ p_account_id }) {
      const now = new Date();
      const since = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      const native = (asset) => ['ETH', 'NATIVE', 'ETHER'].includes(String(asset || 'ETH').toUpperCase());
      const today = (row) => new Date(row.created_at || now).getTime() >= since;
      const toUnits = (value) => {
        const [whole, frac = ''] = String(value).split('.');
        return BigInt(whole || '0') * 10n ** 18n + BigInt((frac + '0'.repeat(18)).slice(0, 18));
      };
      let total = 0n;
      for (const t of db.tables.transfers || []) {
        if (String(t.account_id) !== String(p_account_id) || !today(t)) continue;
        if (!['pending', 'submitted', 'confirmed'].includes(t.status)) continue;
        if (!native(t.asset) || (t.kind || 'transfer') === 'swap' || (t.direction || 'out') !== 'out') continue;
        total += toUnits(t.amount_eth);
      }
      for (const c of db.tables.claims || []) {
        if (String(c.from_account_id) !== String(p_account_id) || !today(c)) continue;
        if (!['pending', 'processing', 'claimed'].includes(c.status)) continue;
        if (!native(c.asset)) continue;
        total += toUnits(c.amount_eth);
      }
      const text = `${total / 10n ** 18n}.${String(total % 10n ** 18n).padStart(18, '0')}`;
      return { data: text, error: null };
    },

    /** 20260925010000_tasks.sql: entries per task, tasks with none absent. */
    task_participant_counts({ p_task_ids }) {
      const wanted = new Set((p_task_ids || []).map(String));
      const counts = new Map();
      for (const s of db.tables.task_submissions || []) {
        const id = String(s.task_id);
        if (wanted.has(id)) counts.set(id, (counts.get(id) || 0) + 1);
      }
      return {
        data: [...counts].map(([task_id, participants]) => ({ task_id, participants })),
        error: null,
      };
    },

    /** 20261009120000_project_workspace.sql: awarded XP per account, highest first. */
    project_xp_leaderboard({ p_project_id, p_limit }) {
      const taskIds = new Set(
        (db.tables.tasks || []).filter((t) => String(t.project_id) === String(p_project_id)).map((t) => String(t.id))
      );
      const totals = new Map();
      for (const w of db.tables.task_winners || []) {
        if (!taskIds.has(String(w.task_id)) || !(Number(w.xp) > 0)) continue;
        const row = totals.get(String(w.account_id)) || { account_id: String(w.account_id), xp: 0, wins: 0 };
        row.xp += Number(w.xp);
        row.wins += 1;
        totals.set(row.account_id, row);
      }
      const limit = Math.max(1, Math.min(Number(p_limit) || 50, 100));
      const all = [...totals.values()].sort((a, b) => b.xp - a.xp || b.wins - a.wins);
      const total_xp = all.reduce((sum, r) => sum + r.xp, 0);
      const data = all.slice(0, limit).map((r) => ({ ...r, total_xp, earners: all.length }));
      return { data, error: null };
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
