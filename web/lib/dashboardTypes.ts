export type PendingClaimItem = {
  id: string;
  amountEth: string;
  status: string;
  label: string;
  counterparty: string | null;
  createdAt: string | null;
  claimToken: string | null;
  kind?: 'phone' | 'platform';
  canClaimOnWeb?: boolean;
};

export type DashboardData = {
  account: {
    // No id. The account id is agent wallet key material and never leaves the
    // server. See web/lib/publicAccount.ts.
    email?: string | null;
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
};

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
  label: string;
};

export type HoldingsData = {
  credit: number | string;
  agent_wallet_address?: string | null;
  holdings: {
    chain: { name: string; chainId: number; explorerBaseUrl: string };
    native: { symbol: string; balance: string } | null;
    tokens: Array<{ symbol: string; address: string | null; balance: string | null; error?: string }>;
    note?: string | null;
  };
};

export function shortAddr(addr: string) {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}
