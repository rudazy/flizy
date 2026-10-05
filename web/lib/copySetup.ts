/**
 * Copy Trade and Copy Mint configuration.
 *
 * This module stores wallets and limits. It does not watch a chain and it does
 * not submit a transaction. A toggle saved here is a preference for a later
 * Action, and the screen that calls this has to say that copying is off.
 *
 * Trade and mint are separate lists on purpose. Following a wallet into a
 * token buy is a different instruction from following it into a mint.
 *
 * Trade can also store dollar rules (a `rules` object on the save). Those
 * rules are still only configuration. Mint never writes them. An older trade
 * save with no `rules` object keeps the ETH limits this file already stored.
 */

import { ethers } from 'ethers';
import { getSupabase } from './supabase.ts';
import { ClientError } from './apiError.ts';
import { walletLabel } from './copyPaste.ts';
import {
  RULES_NOT_INSTALLED,
  SETUP_RULE_COLUMNS,
  WALLET_RULE_COLUMNS,
  assertOverridesFit,
  blankRules,
  isMissingRulesColumn,
  overrideFromRow,
  overrideToColumns,
  parseCommittedRules,
  parseWalletOverride,
  rulesFromRow,
  rulesToColumns,
  type CopyTradeRules,
  type WalletOverride,
} from './copyTradeRules.ts';

export type Db = ReturnType<typeof getSupabase>;

function db(client?: Db): Db {
  return client ?? getSupabase();
}

export type CopyKind = 'trade' | 'mint';

export type CopyWallet = {
  address: string;
  label: string;
  enabled: boolean;
  position: number;
  /** Null on mint and on an ETH-only trade save. Null fields inside mean "use the default". */
  override: WalletOverride | null;
};

export type CopySetup = {
  kind: CopyKind;
  wallets: CopyWallet[];
  allocationEth: string;
  perTradeEth: string;
  maxTradeEth: string;
  maxDailyEth: string;
  maxDailyCount: number;
  copyBuys: boolean;
  copySells: boolean;
  slippagePct: string;
  saved: boolean;
  /** Null for mint. For trade, ready is false until a dollar rule set is saved. */
  rules: CopyTradeRules | null;
};

const MAX_WALLETS = 100;
const ZERO = '0x0000000000000000000000000000000000000000';

export function isCopyKind(value: string): value is CopyKind {
  return value === 'trade' || value === 'mint';
}

function labelIndex(label: string): number | null {
  const letter = /^Wallet ([A-Z])$/.exec(label);
  if (letter) return letter[1].charCodeAt(0) - 65;
  const number = /^Wallet (\d+)$/.exec(label);
  if (!number) return null;
  const index = Number(number[1]) - 1;
  return Number.isInteger(index) && index >= 26 ? index : null;
}

function nextLabel(used: Set<number>): string {
  let index = 0;
  while (used.has(index)) index += 1;
  return walletLabel(index);
}

type WalletDraft = {
  address: string;
  enabled: boolean;
  label: string | null;
  override: WalletOverride | null;
};

type Normalized = {
  kind: CopyKind;
  wallets: CopyWallet[];
  allocationWei: string;
  perTradeWei: string;
  maxTradeWei: string;
  maxDailyWei: string;
  maxDailyCount: number;
  copyBuys: boolean;
  copySells: boolean;
  slippageBps: number;
};

/**
 * Whole-ETH digits accepted in a limit. Far above any real allocation, and far
 * below the 78-digit CHECK on the wei columns, so an oversized value is refused
 * here with a message instead of by the database.
 */
const MAX_ETH_INTEGER_DIGITS = 9;

function ethToWei(raw: unknown, label: string): bigint {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return 0n;
  if (!/^\d+(\.\d{1,18})?$/.test(text)) {
    throw new ClientError(`${label} needs to be an ETH amount.`);
  }
  if (text.split('.')[0].replace(/^0+/, '').length > MAX_ETH_INTEGER_DIGITS) {
    throw new ClientError(`${label} is too large.`);
  }
  try {
    return ethers.parseEther(text);
  } catch {
    throw new ClientError(`${label} needs to be an ETH amount.`);
  }
}

function slippageToBps(raw: unknown): number {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return 100;
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    throw new ClientError('Slippage must be between 0.10% and 10%.');
  }
  const bps = Math.round(Number(text) * 100);
  if (!Number.isInteger(bps) || bps < 10 || bps > 1000) {
    throw new ClientError('Slippage must be between 0.10% and 10%.');
  }
  return bps;
}

function asBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new ClientError(label);
  return value;
}

/**
 * A name the person typed wins. A save that leaves the name out keeps the
 * previous one, including a rename such as "Smart Money". Only a wallet with
 * no name at all gets the next Wallet A / Wallet B label.
 */
function readLabel(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== 'string') throw new ClientError('A wallet name needs 1 to 32 characters.');
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    throw new ClientError('A wallet name needs 1 to 32 characters.');
  }
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if ([...text].length > 32) throw new ClientError('A wallet name needs 1 to 32 characters.');
  return text;
}

function assignLabels(previous: { address: string; label: string }[], next: WalletDraft[]): CopyWallet[] {
  const prior = new Map(previous.map((wallet) => [wallet.address.toLowerCase(), wallet.label]));
  const used = new Set<number>();
  const drafted = next.map((wallet) => {
    const kept = prior.get(wallet.address.toLowerCase()) ?? null;
    const chosen = wallet.label ?? kept ?? '';
    const index = chosen ? labelIndex(chosen) : null;
    if (index != null) used.add(index);
    return { ...wallet, label: chosen };
  });
  return drafted.map((wallet, position) => {
    let label = wallet.label;
    if (!label) {
      label = nextLabel(used);
      const index = labelIndex(label);
      if (index != null) used.add(index);
    }
    return {
      address: wallet.address,
      label,
      enabled: wallet.enabled,
      position: position + 1,
      override: wallet.override,
    };
  });
}

function assertUniqueLabels(wallets: CopyWallet[]) {
  const seen = new Set<string>();
  for (const wallet of wallets) {
    const key = wallet.label.toLowerCase();
    if (seen.has(key)) throw new ClientError('Each wallet needs its own name.');
    seen.add(key);
  }
}

function normalizeCopyInput(
  body: unknown,
  previous: { address: string; label: string }[],
  ownAddress: string | null
): Normalized {
  if (!body || typeof body !== 'object') throw new ClientError('Enter the copy settings again.');
  const input = body as Record<string, unknown>;
  const kindRaw = String(input.kind || '');
  if (!isCopyKind(kindRaw)) throw new ClientError('Choose trade or mint.');

  if (!Array.isArray(input.wallets)) throw new ClientError('Add wallets as a list.');
  if (input.wallets.length > MAX_WALLETS) throw new ClientError('100 wallets is the limit.');

  const parsed = parseWalletEntries(input.wallets, ownAddress, false);

  const allocationWei = ethToWei(input.allocationEth, 'Allocation');
  const perTradeWei = ethToWei(input.perTradeEth, kindRaw === 'mint' ? 'Max per mint' : 'Amount per trade');
  const maxTradeWei = ethToWei(input.maxTradeEth, kindRaw === 'mint' ? 'Max per mint' : 'Maximum per trade');
  const maxDailyWei = ethToWei(input.maxDailyEth, 'Maximum daily spend');

  if (allocationWei === 0n && (perTradeWei > 0n || maxTradeWei > 0n || maxDailyWei > 0n)) {
    throw new ClientError('Set an allocation first.');
  }
  if (perTradeWei > allocationWei || maxTradeWei > allocationWei || maxDailyWei > allocationWei) {
    throw new ClientError('A limit is above the allocation.');
  }
  if (perTradeWei > 0n && maxTradeWei > 0n && perTradeWei > maxTradeWei) {
    throw new ClientError('Amount per trade is above the maximum per trade.');
  }

  const countRaw = input.maxDailyCount;
  if (typeof countRaw !== 'number' || !Number.isInteger(countRaw)) {
    throw new ClientError('Max per day must be a whole number.');
  }

  const copyBuys = asBoolean(input.copyBuys, 'Choose whether buys are copied.');
  let copySells = asBoolean(input.copySells, 'Choose whether sells are copied.');
  let maxDailyCount = countRaw;
  let slippageBps = slippageToBps(input.slippagePct);

  if (kindRaw === 'mint') {
    copySells = false;
    slippageBps = 100;
    if (allocationWei > 0n && (maxDailyCount < 1 || maxDailyCount > 50)) {
      throw new ClientError('Max mints per day must be from 1 to 50.');
    }
    if (allocationWei === 0n) maxDailyCount = 0;
  } else if (maxDailyCount !== 0) {
    throw new ClientError('Trade copying does not take a mint count.');
  }

  const wallets = assignLabels(previous, parsed);
  assertUniqueLabels(wallets);
  return {
    kind: kindRaw,
    wallets,
    allocationWei: allocationWei.toString(),
    perTradeWei: perTradeWei.toString(),
    maxTradeWei: maxTradeWei.toString(),
    maxDailyWei: maxDailyWei.toString(),
    maxDailyCount,
    copyBuys,
    copySells,
    slippageBps,
  };
}

function weiToEth(wei: string | null | undefined): string {
  if (!wei || wei === '0') return '';
  try {
    return ethers.formatEther(wei).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  } catch {
    return '';
  }
}

function bpsToPct(bps: number): string {
  if (!Number.isInteger(bps)) return '1';
  const pct = bps / 100;
  return String(pct);
}

function emptyCopySetup(kind: CopyKind): CopySetup {
  return {
    kind,
    wallets: [],
    allocationEth: '',
    perTradeEth: '',
    maxTradeEth: '',
    maxDailyEth: '',
    maxDailyCount: 0,
    copyBuys: true,
    copySells: kind === 'trade',
    slippagePct: '1',
    saved: false,
    rules: null,
  };
}

function parseWalletEntries(entries: unknown[], ownAddress: string | null, tradeRules: boolean): WalletDraft[] {
  const own = ownAddress && ethers.isAddress(ownAddress) ? ethers.getAddress(ownAddress).toLowerCase() : null;
  const seen = new Set<string>();
  const parsed: WalletDraft[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') throw new ClientError('Each wallet needs an address.');
    const row = entry as Record<string, unknown>;
    const addressRaw = typeof row.address === 'string' ? row.address.trim() : '';
    if (/^(0x)?[0-9a-fA-F]{64}$/.test(addressRaw)) {
      throw new ClientError('Paste addresses only. A line looked like a key, so nothing was added.');
    }
    if (!ethers.isAddress(addressRaw)) throw new ClientError('One of those is not a wallet address.');
    const address = ethers.getAddress(addressRaw);
    if (address.toLowerCase() === ZERO) throw new ClientError('One of those is not a wallet address.');
    if (own && address.toLowerCase() === own) {
      throw new ClientError('That is your own Flizy wallet.');
    }
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parsed.push({
      address,
      enabled: asBoolean(row.enabled, 'Each wallet is on or off.'),
      label: readLabel(row.label),
      override: tradeRules ? parseWalletOverride(row.override) : null,
    });
  }
  return parsed;
}

function rethrowCopy(error: { message?: string } | null): never {
  const message = error?.message || 'Copy setup could not be saved.';
  if (isMissingRulesColumn(message)) throw new ClientError(RULES_NOT_INSTALLED);
  throw new Error(message);
}

type SetupRow = {
  allocation_wei: string;
  per_trade_wei: string;
  max_trade_wei: string;
  max_daily_wei: string;
  max_daily_count: number;
  copy_buys: boolean;
  copy_sells: boolean;
  slippage_bps: number;
};

const ETH_SETUP_COLUMNS =
  'allocation_wei, per_trade_wei, max_trade_wei, max_daily_wei, max_daily_count, copy_buys, copy_sells, slippage_bps';

function toSetup(
  kind: CopyKind,
  row: (SetupRow & Record<string, unknown>) | null,
  wallets: Array<Record<string, unknown>>
): CopySetup {
  const base = emptyCopySetup(kind);
  const ordered = wallets
    .slice()
    .sort((a, b) => Number(a.position) - Number(b.position))
    .map((wallet) => ({
      address: String(wallet.address),
      label: String(wallet.label),
      enabled: wallet.enabled === true,
      position: Number(wallet.position),
      override: kind === 'trade' ? overrideFromRow(wallet) : null,
    }));
  if (!row) return { ...base, wallets: ordered };
  return {
    kind,
    wallets: ordered,
    allocationEth: weiToEth(row.allocation_wei),
    perTradeEth: weiToEth(row.per_trade_wei),
    maxTradeEth: weiToEth(row.max_trade_wei),
    maxDailyEth: weiToEth(row.max_daily_wei),
    maxDailyCount: Number(row.max_daily_count) || 0,
    copyBuys: row.copy_buys === true,
    copySells: row.copy_sells === true,
    slippagePct: bpsToPct(Number(row.slippage_bps)),
    saved: true,
    rules: kind === 'trade' ? rulesFromRow(row) : null,
  };
}

export async function readCopySetup(accountId: string, kind: CopyKind, client?: Db): Promise<CopySetup> {
  const supabase = db(client);
  const setupColumns =
    kind === 'trade' ? `${ETH_SETUP_COLUMNS}, ${SETUP_RULE_COLUMNS.join(', ')}` : ETH_SETUP_COLUMNS;
  const walletColumns =
    kind === 'trade'
      ? `address, label, enabled, position, ${WALLET_RULE_COLUMNS.join(', ')}`
      : 'address, label, enabled, position';
  const [{ data: setup, error: setupError }, { data: wallets, error: walletError }] = await Promise.all([
    supabase.from('copy_setups').select(setupColumns).eq('account_id', accountId).eq('kind', kind).maybeSingle(),
    supabase.from('copy_wallets').select(walletColumns).eq('account_id', accountId).eq('kind', kind),
  ]);
  if (setupError) {
    if (kind === 'trade') rethrowCopy(setupError);
    throw new Error(setupError.message);
  }
  if (walletError) {
    if (kind === 'trade') rethrowCopy(walletError);
    throw new Error(walletError.message);
  }
  return toSetup(
    kind,
    (setup as (SetupRow & Record<string, unknown>) | null) ?? null,
    (wallets as unknown as Array<Record<string, unknown>> | null) ?? []
  );
}

const COPY_SETUP_STALE = 'These settings changed in another tab. Reload and save again.';

export async function saveCopySetup(accountId: string, body: unknown, client?: Db): Promise<CopySetup> {
  const supabase = db(client);
  const { data: account, error: accountError } = await supabase
    .from('accounts')
    .select('id, agent_wallet_address')
    .eq('id', accountId)
    .maybeSingle();
  if (accountError) throw new Error(accountError.message);
  if (!account) throw new ClientError('Account not found.');

  // Saves of one setup are serialised on updated_at. The version is read before
  // the wallets, and the first write below only lands if it is still that
  // version. A second save that read the same version changes nothing and is
  // told to reload, instead of interleaving its wallet rows with the first.
  const kind = kindOf(body);
  const { data: versionRow, error: versionError } = await supabase
    .from('copy_setups')
    .select('updated_at')
    .eq('account_id', accountId)
    .eq('kind', kind)
    .maybeSingle();
  if (versionError) throw new Error(versionError.message);
  const version = (versionRow as { updated_at?: string } | null)?.updated_at ?? null;

  const current = await readCopySetup(accountId, kind, supabase);
  const ownAddress = (account as { agent_wallet_address?: string | null }).agent_wallet_address ?? null;
  if (kind === 'mint' && hasRules(body)) {
    throw new ClientError('Copy mint does not use trade rules.');
  }
  if (kind === 'trade' && hasRules(body)) {
    return saveTradeRules(supabase, accountId, body, current, ownAddress, version);
  }
  const normalized = normalizeCopyInput(body, current.wallets, ownAddress);

  const settings = {
    allocation_wei: normalized.allocationWei,
    per_trade_wei: normalized.perTradeWei,
    max_trade_wei: normalized.maxTradeWei,
    max_daily_wei: normalized.maxDailyWei,
    max_daily_count: normalized.maxDailyCount,
    copy_buys: normalized.copyBuys,
    copy_sells: normalized.copySells,
    slippage_bps: normalized.slippageBps,
    updated_at: new Date().toISOString(),
  };
  if (version) {
    const { data: moved, error: setupError } = await supabase
      .from('copy_setups')
      .update(settings)
      .eq('account_id', accountId)
      .eq('kind', normalized.kind)
      .eq('updated_at', version)
      .select('account_id');
    if (setupError) throw new Error(setupError.message);
    if (!Array.isArray(moved) || moved.length === 0) throw new ClientError(COPY_SETUP_STALE);
  } else {
    const { error: setupError } = await supabase
      .from('copy_setups')
      .insert({ account_id: accountId, kind: normalized.kind, ...settings });
    if (setupError) {
      if ((setupError as { code?: string }).code === '23505') throw new ClientError(COPY_SETUP_STALE);
      throw new Error(setupError.message);
    }
  }

  await replaceWallets(supabase, accountId, normalized.kind, normalized.wallets, false);
  return readCopySetup(accountId, normalized.kind, supabase);
}

function kindOf(body: unknown): CopyKind {
  if (!body || typeof body !== 'object') throw new ClientError('Enter the copy settings again.');
  const kind = String((body as { kind?: unknown }).kind || '');
  if (!isCopyKind(kind)) throw new ClientError('Choose trade or mint.');
  return kind;
}

function hasRules(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const rules = (body as { rules?: unknown }).rules;
  return Boolean(rules) && typeof rules === 'object' && !Array.isArray(rules);
}

/**
 * Dollar rules for trade. `commit` writes the rule set and clears the old ETH
 * limits (they are not the bounds any more). A save with commit false only
 * changes the wallet list and leaves a saved rule set where it is.
 */
async function saveTradeRules(
  supabase: Db,
  accountId: string,
  body: unknown,
  current: CopySetup,
  ownAddress: string | null,
  version: string | null
): Promise<CopySetup> {
  const input = body as Record<string, unknown>;
  if (!Array.isArray(input.wallets)) throw new ClientError('Add wallets as a list.');
  if (input.wallets.length > MAX_WALLETS) throw new ClientError('100 wallets is the limit.');

  const rulesBody = input.rules as Record<string, unknown>;
  const commit = rulesBody.commit === true;
  const drafts = parseWalletEntries(input.wallets, ownAddress, true);
  const wallets = assignLabels(current.wallets, drafts);
  assertUniqueLabels(wallets);

  const basis = current.rules ?? blankRules();
  const stored = commit ? parseCommittedRules(rulesBody) : basis;
  assertOverridesFit(stored, wallets.map((wallet) => wallet.override));

  const updatedAt = new Date().toISOString();
  const settings = commit
    ? {
        allocation_wei: '0',
        per_trade_wei: '0',
        max_trade_wei: '0',
        max_daily_wei: '0',
        max_daily_count: 0,
        ...rulesToColumns(stored),
        updated_at: updatedAt,
      }
    : { updated_at: updatedAt };

  if (version) {
    const { data: moved, error: setupError } = await supabase
      .from('copy_setups')
      .update(settings)
      .eq('account_id', accountId)
      .eq('kind', 'trade')
      .eq('updated_at', version)
      .select('account_id');
    if (setupError) rethrowCopy(setupError);
    if (!Array.isArray(moved) || moved.length === 0) throw new ClientError(COPY_SETUP_STALE);
  } else {
    const { error: setupError } = await supabase
      .from('copy_setups')
      .insert({ account_id: accountId, kind: 'trade', ...settings });
    if (setupError) {
      if ((setupError as { code?: string }).code === '23505') throw new ClientError(COPY_SETUP_STALE);
      rethrowCopy(setupError);
    }
  }

  await replaceWallets(supabase, accountId, 'trade', wallets, true);
  return readCopySetup(accountId, 'trade', supabase);
}

async function replaceWallets(
  supabase: Db,
  accountId: string,
  kind: CopyKind,
  wallets: CopyWallet[],
  withOverrides: boolean
) {
  // One delete for every row not in the saved list. The list is built only from
  // addresses that were validated and checksummed (0x plus 40 hex), the same
  // form the upsert stores, so it is safe inside a PostgREST filter.
  if (wallets.length) {
    const { error: upsertError } = await supabase.from('copy_wallets').upsert(
      wallets.map((wallet) => ({
        account_id: accountId,
        kind,
        address: wallet.address,
        label: wallet.label,
        enabled: wallet.enabled,
        position: wallet.position,
        ...(withOverrides && wallet.override ? overrideToColumns(wallet.override) : {}),
      })),
      { onConflict: 'account_id,kind,address' }
    );
    if (upsertError) {
      if (withOverrides) rethrowCopy(upsertError);
      throw new Error(upsertError.message);
    }
  }

  let removal = supabase.from('copy_wallets').delete().eq('account_id', accountId).eq('kind', kind);
  if (wallets.length) {
    const keep = wallets.map((wallet) => wallet.address);
    if (!keep.every((address) => /^0x[0-9a-fA-F]{40}$/.test(address))) {
      throw new Error('copy wallet list was not normalized');
    }
    removal = removal.not('address', 'in', `(${keep.join(',')})`);
  }
  const { error: deleteError } = await removal;
  if (deleteError) throw new Error(deleteError.message);
}
