/**
 * Email identity helpers (mirrors lib/email.js for the Vercel web runtime).
 */

const EMAIL_RE =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export function normalizeEmail(raw: unknown): string {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

export function isValidEmail(raw: unknown): boolean {
  const e = normalizeEmail(raw);
  if (!e || e.length > 254) return false;
  if (!EMAIL_RE.test(e)) return false;
  const [local, domain] = e.split('@');
  if (!local || !domain || local.length > 64) return false;
  if (domain.includes('..')) return false;
  return true;
}

export function parseEmail(raw: unknown): string {
  const e = normalizeEmail(raw);
  return isValidEmail(e) ? e : '';
}

export function maskEmail(raw: unknown): string {
  const e = normalizeEmail(raw);
  if (!e || !e.includes('@')) return 'email';
  const [local, domain] = e.split('@');
  const head = local.slice(0, 1) || '?';
  return `${head}…@${domain}`;
}
