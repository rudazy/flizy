export type PendingClaimItem = {
  id: string;
  amountEth: string;
  asset?: string;
  nftTokenId?: string | null;
  status: string;
  label: string;
  counterparty: string | null;
  createdAt: string | null;
  claimToken: string | null;
  kind?: 'phone' | 'platform' | 'email';
  canClaimOnWeb?: boolean;
};

export type DashboardData = {
  account: {
    // No id. The account id is agent wallet key material and never leaves the
    // server. See web/lib/publicAccount.ts.
    email?: string | null;
    email_verified?: boolean;
    display_name?: string | null;
    /** Flizy @username without leading @, or null */
    username?: string | null;
    can_change_username?: boolean;
    username_next_change_at?: string | null;
    /** UI language en | ko | zh */
    locale?: string | null;
    agent_wallet_address?: string | null;
    balance_eth?: number | string;
    has_pin: boolean;
    /** null = app default (or no daily cap if default is 0) */
    daily_send_limit_eth?: number | string | null;
  };
  trusted: Array<{ address: string; label: string }>;
  link?: {
    code: string;
    waDeepLink: string;
    /** null when TELEGRAM_BOT_USERNAME is not configured */
    telegramDeepLink?: string | null;
    expiresAt: string;
  } | null;
  /** Claims this account can receive after proving phone / platform identity */
  pendingClaims?: PendingClaimItem[];
  /**
   * Personal invite link. attributed = signed up via the link; counted = reached a
   * first qualifying transaction; credits = what those counted invites are worth.
   * This is NOT the spendable balance, though the dashboard labels both "Credit"
   * -- see web/lib/inviteCredits.ts.
   */
  invite?: {
    code: string;
    url: string;
    attributed: number;
    counted: number;
    credits: number;
    attachOnClaims: boolean;
  } | null;
  /**
   * Present after a username is set. url is the shareable /pay/{username} form. qrUrl routes on the permanent
   * pay code and is what gets printed -- see web/lib/payCode.ts buildPayUrls.
   */
  pay?: {
    code: string;
    url: string;
    qrUrl: string;
    username: string | null;
    displayName?: string | null;
  } | null;
};

/**
 * A pay code as people read it: nine digits grouped 3-3-3. Unbroken digits are
 * hard to copy off a counter, and the grouping also stops it reading as a bank
 * account number. Anything that is not a well-formed code is returned untouched
 * rather than mangled.
 */
export function formatPayCode(raw: string | null | undefined): string {
  const c = String(raw || '').replace(/[^0-9]/g, '');
  if (c.length !== 9) return String(raw || '');
  return `${c.slice(0, 3)} ${c.slice(3, 6)} ${c.slice(6)}`;
}

/** Legacy transfer row shape */
export type TransferRow = {
  id: string;
  amount_eth: string | number;
  to_address: string;
  status: string;
  tx_hash?: string | null;
  created_at: string;
  kind?: string | null;
  asset?: string | null;
};

/** Unified history desk item (last 30 of all types) */
export type ActivityItem = {
  id: string;
  type: 'transfer' | 'receive' | 'claim' | 'swap' | 'withdraw';
  direction: 'in' | 'out';
  amount: string | number;
  asset: string;
  amountSecondary?: string | null;
  assetSecondary?: string | null;
  counterparty?: string | null;
  status: string;
  txHash?: string | null;
  createdAt: string;
  /** What the payment was for, as the sender typed it. Null when unsaid. */
  note?: string | null;
  label: string;
};

export type HoldingsData = {
  credit: number | string;
  agent_wallet_address?: string | null;
  holdings: {
    chain: { name: string; chainId: number; explorerBaseUrl: string };
    native: { symbol: string; balance: string } | null;
    tokens: Array<{ symbol: string; address: string | null; balance: string | null; error?: string }>;
    nfts?: Array<{
      ticker: string;
      address: string;
      balance: string | null;
      ids: string[];
      error?: string;
    }>;
    note?: string | null;
  };
};

export function shortAddr(addr: string) {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

/**
 * Should this token / NFT row be listed in the wallet?
 *
 * The holdings API deliberately returns every tracked token and listed
 * collection whether or not the account holds any, because other callers want
 * the balance either way — /dashboard/swap reads the FLZ row to print "Bal 0"
 * next to the token picker. The wallet list wants the opposite: a row for
 * something you do not own is noise that reads like a holding.
 *
 * A row we could NOT read is kept, not hidden. Its balance is null with an
 * `error` beside it, and "we could not reach the contract" must never render as
 * "you have none" — that is the one wrong answer here, because it is
 * indistinguishable from the truth and quietly tells someone their NFT is gone.
 */
export function isHeld(balance: string | null | undefined): boolean {
  if (balance == null) return true;
  if (String(balance).trim() === '') return true;
  const n = Number(balance);
  if (!Number.isFinite(n)) return true;
  return n > 0;
}
