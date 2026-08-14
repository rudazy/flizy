/** Public claim URL path. Invite suffix is the username when attach is on. */
export function claimSharePath(token: string, ref?: string | null): string {
  const t = String(token || '').trim();
  if (!t) return '';
  const r = String(ref || '')
    .trim()
    .replace(/^@/, '')
    .toLowerCase();
  if (r && /^[a-z][a-z0-9]{2,23}$/.test(r)) return `/claim/${t}/${r}`;
  return `/claim/${t}`;
}

export function telegramShareHref(url: string, text: string): string {
  const u = String(url || '').trim();
  if (!u) return '';
  const q = new URLSearchParams();
  q.set('url', u);
  const body = String(text || '').trim();
  if (body) q.set('text', body);
  return `https://t.me/share/url?${q.toString()}`;
}

export function claimShareText(url: string, amountEth?: string | null): string {
  const amt = String(amountEth || '').trim();
  const link = String(url || '').trim();
  if (amt) return `You have ${amt} ETH waiting on Flizy. Claim: ${link}`;
  return `You have funds waiting on Flizy. Claim: ${link}`;
}
