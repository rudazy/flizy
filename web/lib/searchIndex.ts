import { FLIZY_FAQ, faqAnchor } from './flizyFaq.ts';

/**
 * Every place in the app search can open, with the words people actually
 * type for it. Matched in the browser as they type, with no request, so the
 * screens and settings come up instantly. Each href names the exact slide.
 *
 * test/siteSearch.test.js checks every href against the routes and slide ids
 * the pages really have, so a renamed slide cannot leave a dead result here.
 */

export type SearchResultKind = 'place' | 'help' | 'token' | 'project' | 'task' | 'nft' | 'person';

export type SearchResult = {
  kind: SearchResultKind;
  title: string;
  subtitle: string;
  href: string;
};

type Place = { title: string; subtitle: string; href: string; keywords: string[] };

export const PLACES: Place[] = [
  { title: 'Home', subtitle: 'Your balance and what needs you', href: '/dashboard', keywords: ['home', 'overview', 'dashboard', 'start'] },
  { title: 'Claims', subtitle: 'Money waiting for you or for others', href: '/dashboard?s=claims', keywords: ['claim', 'claims', 'waiting', 'escrow', 'pending', 'receive'] },
  { title: 'Go', subtitle: 'Shortcuts to what you do most', href: '/dashboard?s=go', keywords: ['go', 'shortcuts', 'quick', 'actions'] },
  { title: 'Invite', subtitle: 'Your invite link and invites earned', href: '/dashboard#invite', keywords: ['invite', 'invites', 'referral', 'refer', 'friends', 'invite link'] },
  { title: 'Send money', subtitle: 'How to send from WhatsApp or Telegram', href: `/how-it-works#${faqAnchor(FLIZY_FAQ.findIndex((item) => /send crypto/i.test(item.question)))}`, keywords: ['send', 'send money', 'transfer', 'pay someone', 'send crypto'] },
  { title: 'Recent', subtitle: 'Your latest activity on Home', href: '/dashboard?s=recent', keywords: ['recent', 'latest', 'activity'] },

  { title: 'Wallet', subtitle: 'Balances of every token you hold', href: '/dashboard/wallet', keywords: ['wallet', 'balance', 'balances', 'tokens', 'holdings', 'eth', 'money'] },
  { title: 'History', subtitle: 'Every send, receive, swap and claim', href: '/dashboard/wallet?s=history', keywords: ['history', 'transactions', 'activity', 'sent', 'received', 'receipts'] },
  { title: 'Fund', subtitle: 'Claim free test ETH in one tap', href: '/dashboard/wallet?s=fund', keywords: ['fund', 'faucet', 'test eth', 'free eth', 'deposit', 'top up', 'add money', 'get eth'] },
  { title: 'Scan', subtitle: 'Every Flizy payment, public ledger', href: '/dashboard/wallet?s=scan', keywords: ['scan', 'ledger', 'explorer', 'payments', 'public'] },
  { title: 'Swap', subtitle: 'Trade ETH and tokens', href: '/dashboard/swap', keywords: ['swap', 'trade', 'exchange', 'buy', 'sell', 'convert'] },

  { title: 'Explore tasks', subtitle: 'Live tasks you can enter', href: '/dashboard/explore', keywords: ['explore', 'tasks', 'quests', 'bounties', 'earn', 'rewards', 'xp'] },
  { title: 'Create a task', subtitle: 'Publish a task for your community', href: '/dashboard/explore/new', keywords: ['create task', 'new task', 'publish', 'bounty', 'campaign'] },
  { title: 'Tokens', subtitle: 'Listed tokens, prices and copy trade', href: '/dashboard/explore?s=tokens', keywords: ['tokens', 'coins', 'market', 'prices', 'flz', 'copy trade', 'watchlist'] },
  { title: 'NFTs', subtitle: 'Collections, listings and mints', href: '/dashboard/explore?s=nfts', keywords: ['nft', 'nfts', 'collections', 'art', 'marketplace'] },
  { title: 'My NFTs', subtitle: 'The NFTs in your wallet', href: '/dashboard/explore/nfts/me', keywords: ['my nfts', 'owned', 'collection', 'gallery'] },
  { title: 'Mints', subtitle: 'Drops you can mint now', href: '/dashboard/explore/nfts/mints', keywords: ['mint', 'mints', 'drop', 'drops', 'launch'] },
  { title: 'Create a collection', subtitle: 'Launch an NFT drop', href: '/dashboard/explore/nfts/create', keywords: ['create collection', 'new collection', 'launch nft', 'drop'] },

  { title: 'Profile', subtitle: 'Your name, username and email', href: '/dashboard/account', keywords: ['profile', 'account', 'username', 'name', 'email', 'display name'] },
  { title: 'Projects', subtitle: 'Your projects and their pages', href: '/dashboard/account?s=projects', keywords: ['projects', 'project', 'brand', 'team', 'workspace'] },
  { title: 'Pay me', subtitle: 'Your pay link, QR and username', href: '/dashboard/account?s=pay', keywords: ['pay me', 'receive', 'qr', 'pay link', 'get paid', 'request'] },
  { title: 'Language', subtitle: 'English or Korean', href: '/dashboard/account?s=language', keywords: ['language', 'korean', 'english', 'translate'] },
  { title: 'Country', subtitle: 'Your phone number country', href: '/dashboard/account?s=country', keywords: ['country', 'region', 'phone code', 'calling code'] },
  { title: 'Chat', subtitle: 'Link WhatsApp and Telegram', href: '/dashboard/account?s=chat', keywords: ['chat', 'whatsapp', 'telegram', 'link', 'bot', 'connect'] },
  { title: 'Platforms', subtitle: 'GitHub, Discord and X', href: '/dashboard/account?s=platforms', keywords: ['platforms', 'github', 'discord', 'x', 'twitter', 'social'] },
  { title: 'Trusted', subtitle: 'Addresses you can send to', href: '/dashboard/account?s=trusted', keywords: ['trusted', 'addresses', 'contacts', 'whitelist', 'saved', 'send to'] },
  { title: 'PIN', subtitle: 'The PIN that unlocks chat', href: '/dashboard/account?s=pin', keywords: ['pin', 'unlock', 'code', 'lock'] },
  { title: 'Limits', subtitle: 'Your daily send limit', href: '/dashboard/account?s=limits', keywords: ['limits', 'limit', 'daily limit', 'cap', 'spending'] },
  { title: 'Security', subtitle: 'Password and sessions', href: '/dashboard/account?s=security', keywords: ['security', 'password', 'change password', 'sessions', 'sign out', 'logout', 'log out'] },

  { title: 'How Flizy works', subtitle: 'The guide and answers', href: '/how-it-works', keywords: ['help', 'guide', 'how', 'faq', 'support', 'docs'] },
];

/** The places shown before anything is typed. */
export const POPULAR_PLACES: SearchResult[] = ['/dashboard/wallet?s=fund', '/dashboard/account?s=pay', '/dashboard/swap', '/dashboard/explore', '/dashboard/account?s=chat']
  .map((href) => PLACES.find((p) => p.href === href))
  .filter((p): p is Place => p != null)
  .map((p) => ({ kind: 'place', title: p.title, subtitle: p.subtitle, href: p.href }));

/** Lower case, letters and digits only, single spaces. */
export function normalizeQuery(raw: string): string {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9#@ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * How well a candidate matches: higher is better, 0 is no match. An exact
 * word beats a word that starts the same, which beats a match anywhere.
 */
function score(q: string, title: string, words: string[], extra: string): number {
  const t = normalizeQuery(title);
  const all = [t, ...words.map(normalizeQuery)];
  if (t === q) return 100;
  if (all.includes(q)) return 90;
  if (t.startsWith(q)) return 80;
  if (all.some((w) => w.startsWith(q))) return 70;
  if (all.some((w) => w.split(' ').some((part) => part.startsWith(q)))) return 60;
  if (all.some((w) => w.includes(q)) || normalizeQuery(extra).includes(q)) return 40;
  return 0;
}

export function matchPlaces(raw: string, limit = 6): SearchResult[] {
  const q = normalizeQuery(raw);
  if (!q) return [];
  return PLACES.map((p) => ({ p, s: score(q, p.title, p.keywords, p.subtitle) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map(({ p }) => ({ kind: 'place' as const, title: p.title, subtitle: p.subtitle, href: p.href }));
}

export function matchHelp(raw: string, limit = 3): SearchResult[] {
  const q = normalizeQuery(raw);
  if (q.length < 3) return [];
  return FLIZY_FAQ.map((item, index) => ({ item, index, s: score(q, item.question, [], item.answer) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map(({ item, index }) => ({
      kind: 'help' as const,
      title: item.question,
      subtitle: item.answer.length > 110 ? `${item.answer.slice(0, 107)}...` : item.answer,
      href: `/how-it-works#${faqAnchor(index)}`,
    }));
}
