/**
 * One name, one rule.
 *
 * The schema guard knows check constraints by name only. If a migration
 * changes a rule and keeps its name, a database still holding the old rule
 * looks complete, which is how transfers.amount_eth kept rejecting NFT
 * listings. So a check constraint name is added by exactly one migration; a
 * changed rule gets a new name.
 *
 * Two ways a name gets reused: added explicitly in more than one migration, or
 * added explicitly under the name Postgres gave an earlier unnamed column check
 * (<table>_<column>_check). Both fail here. The twelve reuses that happened
 * before this rule existed are listed below, and each must be renamed by
 * 20261002150000_schema_guard_checks.sql so the guard sees one name per rule.
 *
 * Run: node --test test/schemaChecks.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'supabase', 'migrations');
const FILES = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
const CATCH_UP = '20261002150000_schema_guard_checks.sql';

/** Reused before this rule existed. Frozen: the list may only shrink. */
const GRANDFATHERED = new Set([
  'channel_identities.channel_identities_channel_check',
  'sessions.sessions_channel_check',
  'claims.claims_invite_code_format',
  'claims.claims_recipient_mode_check',
  'invite_attributions.invite_attributions_source_check',
  'invite_codes.invite_codes_code_format',
  'pay_codes.pay_codes_code_format',
  'payment_requests.payment_requests_status_check',
  'transfers.transfers_amount_eth_check',
  'claims.claims_status_check',
  'notifications.notifications_channel_check',
  'email_verifications.email_verifications_purpose_check',
]);

function stripComments(sql) {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Split a parenthesised list on top-level commas. */
function topLevelItems(body) {
  const items = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (const ch of body) {
    if (ch === "'") quoted = !quoted;
    if (!quoted && ch === '(') depth += 1;
    if (!quoted && ch === ')') depth -= 1;
    if (!quoted && depth === 0 && ch === ',') {
      items.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

/** The body of every create table, by table. */
function createTables(sql) {
  const out = [];
  const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z0-9_]+)\s*\(/gi;
  let m;
  while ((m = re.exec(sql))) {
    let depth = 1;
    let i = re.lastIndex;
    let quoted = false;
    for (; i < sql.length && depth > 0; i += 1) {
      const ch = sql[i];
      if (ch === "'") quoted = !quoted;
      if (!quoted && ch === '(') depth += 1;
      if (!quoted && ch === ')') depth -= 1;
    }
    out.push({ table: m[1].toLowerCase(), body: sql.slice(re.lastIndex, i - 1) });
  }
  return out;
}

/** Every explicitly named check, as table.name, with the files that add it, and Postgres's names for unnamed column checks. */
function survey() {
  const named = new Map();
  const autoNamed = new Map();
  for (const file of FILES) {
    const sql = stripComments(fs.readFileSync(path.join(DIR, file), 'utf8'));
    const note = (name) => {
      if (!named.has(name)) named.set(name, new Set());
      named.get(name).add(file);
    };
    for (const { table, body } of createTables(sql)) {
      for (const item of topLevelItems(body)) {
        const inline = /^constraint\s+([a-z0-9_]+)\s+check\b/i.exec(item);
        if (inline) {
          note(`${table}.${inline[1].toLowerCase()}`);
          continue;
        }
        const column = /^([a-z_][a-z0-9_]*)\s/i.exec(item);
        if (column && /\bcheck\s*\(/i.test(item) && !/^(constraint|primary|unique|foreign|check)$/i.test(column[1])) {
          const name = `${table}.${table}_${column[1].toLowerCase()}_check`;
          if (!autoNamed.has(name)) autoNamed.set(name, file);
        }
      }
    }
    const alter = /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?([a-z0-9_]+)([^;]*)/gi;
    let a;
    while ((a = alter.exec(sql))) {
      for (const c of a[2].matchAll(/add\s+constraint\s+([a-z0-9_]+)\s+check\b/gi)) {
        note(`${a[1].toLowerCase()}.${c[1].toLowerCase()}`);
      }
    }
  }
  return { named, autoNamed };
}

describe('check constraint names', () => {
  const { named, autoNamed } = survey();

  it('sees the rules it is meant to see', () => {
    assert.ok(named.has('limit_orders.limit_orders_side_check'));
    assert.ok(autoNamed.has('transfers.transfers_amount_eth_check'), 'the inline rule transfers started with');
  });

  it('no rule name is added by two migrations, outside the frozen list', () => {
    const reused = [...named]
      .filter(([name, files]) => files.size > 1 && !GRANDFATHERED.has(name))
      .map(([name, files]) => `${name}: ${[...files].join(', ')}`);
    assert.deepEqual(reused, [], 'a changed rule needs a new name');
  });

  it("no migration reuses the name Postgres gave an earlier unnamed column check", () => {
    const reused = [...named.keys()].filter(
      (name) => autoNamed.has(name) && [...named.get(name)].some((f) => f > autoNamed.get(name)) && !GRANDFATHERED.has(name)
    );
    assert.deepEqual(reused, [], 'a changed rule needs a new name');
  });

  it('the frozen list holds only real reuses', () => {
    for (const name of GRANDFATHERED) {
      const files = named.get(name) ?? new Set();
      assert.ok(files.size > 1 || (autoNamed.has(name) && files.size >= 1), `${name} is no longer a reuse; drop it from the list`);
    }
  });

  it('every grandfathered rule is renamed to a unique name by the catch-up migration', () => {
    const sql = fs.readFileSync(path.join(DIR, CATCH_UP), 'utf8');
    for (const name of GRANDFATHERED) {
      const [table, constraint] = name.split('.');
      assert.ok(
        sql.includes(`alter table public.${table} rename constraint ${constraint} to ${constraint}_v2;`),
        `${name} is not renamed`
      );
      assert.ok(!named.has(`${table}.${constraint}_v2`), `${constraint}_v2 must not be added anywhere else`);
    }
  });
});
