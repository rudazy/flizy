/**
 * Copy Trade and Copy Mint configuration.
 *
 * This module stores wallets and limits. It does not watch a chain and it does
 * not submit a transaction. A toggle saved here is a preference for a later
 * Action, and the screen that calls this has to say that copying is off.
 *
 * Trade and mint are separate lists on purpose. Following a wallet into a
 * token buy is a different instruction from following it into a mint.
 */

import { ethers } from 'ethers';
import { getSupabase } from './supabase.ts';
import { ClientError } from './apiError.ts';
import { walletLabel } from './copyPaste.ts';

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

function assignLabels(
  previous: { address: string; label: string }[],
  next: { address: string; enabled: boolean }[]
): CopyWallet[] {
  const prior = new Map(previous.map((wallet) => [wallet.address.toLowerCase(), wallet.label]));
  const used = new Set<number>();
  const drafted = next.map((wallet) => {
    const kept = prior.get(wallet.address.toLowerCase());
    const index = kept ? labelIndex(kept) : null;
    if (kept && index != null) {
      used.add(index);
      return { address: wallet.address, enabled: wallet.enabled, label: kept };
    }
    return { address: wallet.address, enabled: wallet.enabled, label: '' };
  });
  return drafted.map((wallet, position) => {
    const label = wallet.label || nextLabel(used);
    const index = labelIndex(label);
    if (index != null) used.add(index);
    return {
      address: wallet.address,
      label,
      enabled: wallet.enabled,
      position: position + 1,
    };
  });
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

  const own = ownAddress && ethers.isAddress(ownAddress) ? ethers.getAddress(ownAddress).toLowerCase() : null;
  const seen = new Set<string>();
  const parsed: { address: string; enabled: boolean }[] = [];
  for (const entry of input.wallets) {
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
    parsed.push({ address, enabled: asBoolean(row.enabled, 'Each wallet is on or off.') });
  }

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

  return {
    kind: kindRaw,
    wallets: assignLabels(previous, parsed),
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
  };
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

type WalletRow = {
  address: string;
  label: string;
  enabled: boolean;
  position: number;
};

function toSetup(kind: CopyKind, row: SetupRow | null, wallets: WalletRow[]): CopySetup {
  const base = emptyCopySetup(kind);
  const ordered = wallets
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((wallet) => ({
      address: wallet.address,
      label: wallet.label,
      enabled: wallet.enabled === true,
      position: wallet.position,
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
  };
}

export async function readCopySetup(accountId: string, kind: CopyKind, client?: Db): Promise<CopySetup> {
  const supabase = db(client);
  const [{ data: setup, error: setupError }, { data: wallets, error: walletError }] = await Promise.all([
    supabase
      .from('copy_setups')
      .select(
        'allocation_wei, per_trade_wei, max_trade_wei, max_daily_wei, max_daily_count, copy_buys, copy_sells, slippage_bps'
      )
      .eq('account_id', accountId)
      .eq('kind', kind)
      .maybeSingle(),
    supabase
      .from('copy_wallets')
      .select('address, label, enabled, position')
      .eq('account_id', accountId)
      .eq('kind', kind),
  ]);
  if (setupError) throw new Error(setupError.message);
  if (walletError) throw new Error(walletError.message);
  return toSetup(kind, (setup as SetupRow | null) ?? null, (wallets as WalletRow[] | null) ?? []);
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
  const normalized = normalizeCopyInput(
    body,
    current.wallets,
    (account as { agent_wallet_address?: string | null }).agent_wallet_address ?? null
  );

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

  if (normalized.wallets.length) {
    const { error: upsertError } = await supabase.from('copy_wallets').upsert(
      normalized.wallets.map((wallet) => ({
        account_id: accountId,
        kind: normalized.kind,
        address: wallet.address,
        label: wallet.label,
        enabled: wallet.enabled,
        position: wallet.position,
      })),
      { onConflict: 'account_id,kind,address' }
    );
    if (upsertError) throw new Error(upsertError.message);
  }

  // One delete for every row not in the saved list. The list is built only from
  // addresses normalizeCopyInput validated and checksummed (0x plus 40 hex), the
  // same form the upsert above stored, so it is safe inside a PostgREST filter.
  let removal = supabase
    .from('copy_wallets')
    .delete()
    .eq('account_id', accountId)
    .eq('kind', normalized.kind);
  if (normalized.wallets.length) {
    const keep = normalized.wallets.map((wallet) => wallet.address);
    if (!keep.every((address) => /^0x[0-9a-fA-F]{40}$/.test(address))) {
      throw new Error('copy wallet list was not normalized');
    }
    removal = removal.not('address', 'in', `(${keep.join(',')})`);
  }
  const { error: deleteError } = await removal;
  if (deleteError) throw new Error(deleteError.message);

  return readCopySetup(accountId, normalized.kind, supabase);
}

function kindOf(body: unknown): CopyKind {
  if (!body || typeof body !== 'object') throw new ClientError('Enter the copy settings again.');
  const kind = String((body as { kind?: unknown }).kind || '');
  if (!isCopyKind(kind)) throw new ClientError('Choose trade or mint.');
  return kind;
}
