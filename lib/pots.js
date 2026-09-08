/**
 * Named pots: group money that exists before anyone is asked.
 *
 * A pot is the one thing split bill deliberately is not — a row. Split bill has
 * no table because its total, creator and progress all derive from the requests
 * it created. A pot has none of that to derive from at the moment it is made:
 * it is named, shared, and only later paid into.
 *
 * What is still derived, and must stay that way: **the running total.** There is
 * no balance column on `pots`. A total is summed from the transfers pointing at
 * it, every time it is asked for. A stored total can drift from the rows it
 * describes; a counted one cannot.
 *
 * Money model: a contribution settles straight to the organiser's wallet, the
 * same way paying a request does. The pot holds nothing. It is a ledger of who
 * put in what, and contributors see a running total rather than a guarantee.
 */

const crypto = require('crypto');

const { getSupabase } = require('./supabase');
const { displaySafeLabel } = require('./sanitize');
const { formatAmount } = require('./amountDisplay');

/**
 * Deliberately not the pay-code alphabet. Pay codes are nine digits; a pot code
 * is short and mixed, so the two never look like each other in a chat where
 * both may appear, and so `pay 123456789` can never be read as a pot.
 * Ambiguous glyphs are left out because these get read aloud and retyped.
 */
const POT_CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const POT_CODE_LENGTH = 6;
const POT_CODE_FORMAT = /^[abcdefghjkmnpqrstuvwxyz23456789]{6}$/;
const POT_CODE_ISSUE_TRIES = 8;

/** A pot with no goal is legal; a pot with a blank name is not. */
const POT_NAME_MAX = 60;

/** Statuses the table will accept. */
const POT_STATUS = Object.freeze({ OPEN: 'open', CLOSED: 'closed' });

/**
 * The table may not exist yet: migrations here are applied by hand, so the code
 * ships before the schema does. Callers turn this into "not available yet"
 * rather than a stack trace.
 */
function isMissingRelation(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || '');
  return code === '42P01' || code === 'PGRST205' || /does not exist/i.test(message);
}

/** Anything a human might type or paste, reduced to the stored form. */
function normalizePotCode(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function isPotCodeFormat(raw) {
  return POT_CODE_FORMAT.test(normalizePotCode(raw));
}

function mintPotCode() {
  let out = '';
  for (let i = 0; i < POT_CODE_LENGTH; i += 1) {
    out += POT_CODE_ALPHABET[crypto.randomInt(POT_CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * Trim a typed pot name to something a menu can show without wrapping.
 * Returns null when nothing is left, which the caller refuses on.
 */
function normalizePotName(raw) {
  const name = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!name) return null;
  return name.slice(0, POT_NAME_MAX);
}

/**
 * @param {object} p
 * @param {string} p.ownerAccountId
 * @param {string} p.name
 * @param {string|null} [p.targetEth] null for an open-ended pot
 * @param {number|null} [p.chainId]
 * @returns {Promise<object>} the created row
 */
async function createPot(p) {
  const supabase = getSupabase();
  const name = normalizePotName(p.name);
  if (!name) throw new Error('A pot needs a name. Say what it is for.');

  // Unique across every pot, so a collision is possible and simply retried.
  let lastError = null;
  for (let i = 0; i < POT_CODE_ISSUE_TRIES; i += 1) {
    const code = mintPotCode();
    const { data, error } = await supabase
      .from('pots')
      .insert({
        owner_account_id: p.ownerAccountId,
        code,
        name,
        target_eth: p.targetEth || null,
        chain_id: p.chainId || null,
        status: POT_STATUS.OPEN,
      })
      .select('*')
      .single();

    if (!error) return data;
    if (isMissingRelation(error)) {
      throw new Error('Pots are not available yet.');
    }
    // 23505 is the unique index on lower(code). Anything else is real.
    if (String(error.code || '') !== '23505') {
      throw new Error(error.message);
    }
    lastError = error;
  }
  throw new Error(lastError?.message || 'Could not issue a pot code.');
}

/**
 * By id, for the send-confirm path: it carries plan.potId and never saw the
 * code the payer typed.
 * @returns {Promise<object|null>}
 */
async function getPotById(id) {
  if (!id) return null;
  const supabase = getSupabase();
  const { data, error } = await supabase.from('pots').select('*').eq('id', id).maybeSingle();
  if (error) {
    if (isMissingRelation(error)) return null;
    throw new Error(error.message);
  }
  return data || null;
}

/** @returns {Promise<object|null>} */
async function getPotByCode(code) {
  const supabase = getSupabase();
  const normalized = normalizePotCode(code);
  if (!isPotCodeFormat(normalized)) return null;

  const { data, error } = await supabase
    .from('pots')
    .select('*')
    .eq('code', normalized)
    .maybeSingle();
  if (error) {
    if (isMissingRelation(error)) return null;
    throw new Error(error.message);
  }
  return data || null;
}

/** @returns {Promise<object[]>} newest first */
async function listPotsForAccount(accountId, { status = null, limit = 20 } = {}) {
  const supabase = getSupabase();
  let q = supabase
    .from('pots')
    .select('*')
    .eq('owner_account_id', accountId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (status) q = q.eq('status', status);

  const { data, error } = await q;
  if (error) {
    if (isMissingRelation(error)) return [];
    throw new Error(error.message);
  }
  return data || [];
}

/**
 * Sum what has actually landed, per pot.
 *
 * Only `confirmed` counts. A pending or failed transfer is money that has not
 * arrived, and showing it in a total would tell an organiser they have been
 * paid when they have not.
 *
 * @param {string[]} potIds
 * @returns {Promise<Map<string, { totalEth: number, count: number, contributors: number }>>}
 */
async function potTotals(potIds) {
  const ids = (potIds || []).filter(Boolean);
  const out = new Map();
  for (const id of ids) out.set(id, { totalEth: 0, count: 0, contributors: 0 });
  if (!ids.length) return out;

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('transfers')
    .select('pot_id, amount_eth, account_id, status')
    .in('pot_id', ids)
    .eq('status', 'confirmed');
  if (error) {
    if (isMissingRelation(error)) return out;
    throw new Error(error.message);
  }

  const seen = new Map();
  for (const row of data || []) {
    const bucket = out.get(row.pot_id);
    if (!bucket) continue;
    bucket.totalEth += Number(row.amount_eth || 0);
    bucket.count += 1;
    if (!seen.has(row.pot_id)) seen.set(row.pot_id, new Set());
    if (row.account_id) seen.get(row.pot_id).add(row.account_id);
  }
  for (const [id, people] of seen) out.get(id).contributors = people.size;
  return out;
}

/**
 * Who put in what, newest first. Used by the pot detail view.
 * @returns {Promise<object[]>}
 */
async function listPotContributions(potId, { limit = 20 } = {}) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('transfers')
    .select('amount_eth, account_id, counterparty_label, created_at, tx_hash, status')
    .eq('pot_id', potId)
    .eq('status', 'confirmed')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    if (isMissingRelation(error)) return [];
    throw new Error(error.message);
  }
  return data || [];
}

/**
 * Closing stops new contributions. It moves no money, because every
 * contribution already settled to the organiser as it arrived.
 * @returns {Promise<object|null>} the updated row, or null if it was not theirs
 */
async function closePot(potId, ownerAccountId) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('pots')
    .update({ status: POT_STATUS.CLOSED, closed_at: new Date().toISOString() })
    .eq('id', potId)
    .eq('owner_account_id', ownerAccountId)
    .eq('status', POT_STATUS.OPEN)
    .select('*')
    .maybeSingle();
  if (error) {
    if (isMissingRelation(error)) return null;
    throw new Error(error.message);
  }
  return data || null;
}

/**
 * Renaming after the fact is one of the three reasons a pot is a table rather
 * than a repeated label on the rows it created.
 */
async function renamePot(potId, ownerAccountId, rawName) {
  const supabase = getSupabase();
  const name = normalizePotName(rawName);
  if (!name) throw new Error('A pot needs a name. Say what it is for.');

  const { data, error } = await supabase
    .from('pots')
    .update({ name })
    .eq('id', potId)
    .eq('owner_account_id', ownerAccountId)
    .select('*')
    .maybeSingle();
  if (error) {
    if (isMissingRelation(error)) return null;
    throw new Error(error.message);
  }
  return data || null;
}

/**
 * "1.5 of 5 ETH" when there is a goal, "1.5 ETH" when there is not.
 * A pot with no target is not incomplete; it simply has no finish line.
 */
function potProgressLine(pot, totals) {
  const t = totals || { totalEth: 0 };
  const have = formatAmount(t.totalEth);
  if (pot.target_eth == null) return `${have} ETH in`;
  const target = formatAmount(pot.target_eth);
  return `${have} of ${target} ETH`;
}

/** True once a pot with a goal has reached it. Overshooting still counts. */
function potIsFunded(pot, totals) {
  if (pot.target_eth == null) return false;
  return Number(totals?.totalEth || 0) >= Number(pot.target_eth);
}

/**
 * Body the organiser reads when somebody pays into their pot.
 *
 * A contribution settles straight to their wallet, so without this they would
 * see an unexplained arrival and nothing tying it to the pot. Both the name and
 * the payer label came from other people: rendered through displaySafeLabel so
 * a newline cannot forge extra lines of what reads as a Flizy message.
 */
function formatPotContributionNotice(p) {
  const lines = [
    `${displaySafeLabel(p.byLabel || 'someone')} put ${p.amountEth} ETH into ${displaySafeLabel(p.potName)}.`,
  ];
  if (p.progress) lines.push(p.progress);
  lines.push('', `See it: {{cmd:pot ${p.code}}}`);
  return lines.join('\n');
}

/**
 * The organiser's list. Shows the code, because the code is how anyone pays in.
 */
function formatPotsMenu(pots, totals) {
  if (!pots || !pots.length) {
    return [
      'No pots yet.',
      '',
      'Start one and share the code:',
      '  {{cmd:collect 5 for rent}}',
      '  {{cmd:collect for team lunch}}   (no goal)',
    ].join('\n');
  }

  const lines = ['Your pots:', ''];
  for (const pot of pots) {
    const t = totals?.get?.(pot.id);
    const flag = pot.status === POT_STATUS.CLOSED
      ? '  [closed]'
      : potIsFunded(pot, t)
        ? '  [funded]'
        : '';
    lines.push(`${pot.code}  ${displaySafeLabel(pot.name)}`);
    lines.push(`  ${potProgressLine(pot, t)}${flag}`);
  }
  lines.push('');
  lines.push('Details: {{cmd:pot <code>}}');
  return lines.join('\n');
}

/**
 * One pot, for the organiser or for anyone holding the code.
 * `mine` decides whether the closing instruction is shown; a contributor
 * cannot close someone else's pot and should not be told to try.
 */
function formatPotDetail(pot, totals, contributions, { mine = false } = {}) {
  const t = totals || { totalEth: 0, count: 0, contributors: 0 };
  const lines = [
    displaySafeLabel(pot.name),
    potProgressLine(pot, t),
  ];

  if (pot.status === POT_STATUS.CLOSED) {
    lines.push('Closed. No longer collecting.');
  } else if (potIsFunded(pot, t)) {
    lines.push('Goal reached. Still open.');
  }

  if (t.count) {
    const people = t.contributors === 1 ? '1 person' : `${t.contributors} people`;
    lines.push(`${people}, ${t.count === 1 ? '1 payment' : `${t.count} payments`}`);
  }

  if (contributions && contributions.length) {
    lines.push('');
    for (const c of contributions) {
      const who = c.counterparty_label ? displaySafeLabel(c.counterparty_label) : 'someone';
      lines.push(`  ${formatAmount(c.amount_eth)} ETH  ${who}`);
    }
  }

  lines.push('');
  if (pot.status === POT_STATUS.OPEN) {
    // No amount: the payer is asked for one, with a figure that fits the
    // per-send cap. Suggesting a round "1" here told everybody to try 1 ETH.
    lines.push(`Pay in: {{cmd:pay pot ${pot.code}}}`);
  }
  if (mine && pot.status === POT_STATUS.OPEN) {
    lines.push(`Close it: {{cmd:close pot ${pot.code}}}`);
  }
  return lines.join('\n');
}

module.exports = {
  POT_CODE_LENGTH,
  POT_CODE_FORMAT,
  POT_NAME_MAX,
  POT_STATUS,
  normalizePotCode,
  isPotCodeFormat,
  mintPotCode,
  normalizePotName,
  createPot,
  getPotByCode,
  getPotById,
  listPotsForAccount,
  potTotals,
  listPotContributions,
  closePot,
  renamePot,
  potProgressLine,
  potIsFunded,
  formatPotContributionNotice,
  formatPotsMenu,
  formatPotDetail,
};
