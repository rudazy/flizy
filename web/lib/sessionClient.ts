/**
 * What a site session may say about the browser that opened it.
 *
 * The label is a short device name. The place is a city and country when the
 * host sends them. Neither value is an address, a user agent, or a token.
 */

const CONTROL = /[\u0000-\u001f\u007f]/g;

export type SessionClient = {
  label: string | null;
  place: string | null;
};

export type StoredSession = {
  id: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
  client_label?: string | null;
  client_place?: string | null;
};

export type PublicSession = {
  id: string;
  label: string | null;
  place: string | null;
  createdAt: string;
  current: boolean;
};

function clean(raw: unknown, max: number): string {
  let text = String(raw || '');
  try {
    text = decodeURIComponent(text);
  } catch {
    text = String(raw || '');
  }
  text = text.replace(CONTROL, '').trim().slice(0, max);
  if (!text || /[<>]/.test(text)) return '';
  return text;
}

/** Chrome on Windows, Safari on iPhone, and the few shapes worth naming. */
export function clientLabel(userAgent: string | null | undefined): string | null {
  const raw = String(userAgent || '').slice(0, 400);
  if (!raw) return null;
  let device = '';
  if (/iPad/.test(raw)) device = 'iPad';
  else if (/iPhone/.test(raw)) device = 'iPhone';
  else if (/Android/.test(raw)) device = 'Android';
  else if (/Mac OS X/.test(raw)) device = 'Mac';
  else if (/Windows/.test(raw)) device = 'Windows';
  else if (/Linux/.test(raw)) device = 'Linux';
  let browser = '';
  if (/Edg\//.test(raw)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(raw)) browser = 'Opera';
  else if (/Chrome\//.test(raw)) browser = 'Chrome';
  else if (/Firefox\//.test(raw)) browser = 'Firefox';
  else if (/Safari\//.test(raw)) browser = 'Safari';
  if (browser && device) return `${browser} on ${device}`;
  if (browser) return browser;
  if (device) return device;
  return null;
}

/** A country is two letters. A longer value is not cut down into a code. */
function countryCode(raw: unknown): string {
  const text = String(raw || '').replace(CONTROL, '').trim();
  return /^[A-Za-z]{2}$/.test(text) ? text.toUpperCase() : '';
}

/**
 * City and country from the host, when it sets them. A caller-supplied copy of
 * these headers is only as trustworthy as the host. Vercel overwrites them.
 */
export function clientPlace(headers: Pick<Headers, 'get'>): string | null {
  const city = clean(headers.get('x-vercel-ip-city'), 40);
  const country = countryCode(headers.get('x-vercel-ip-country'));
  if (city && country) return `${city}, ${country}`;
  if (city) return city;
  if (country) return country;
  return null;
}

export function sessionClientFrom(headers: Pick<Headers, 'get'>): SessionClient {
  return {
    label: clientLabel(headers.get('user-agent')),
    place: clientPlace(headers),
  };
}

/** Live sessions for the signed-in account. The token hash never leaves here. */
export function presentSessions(rows: StoredSession[], currentHash: string, now = Date.now()): PublicSession[] {
  return rows
    .filter((row) => new Date(row.expires_at).getTime() > now)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 20)
    .map((row) => ({
      id: String(row.id),
      label: clean(row.client_label, 80) || null,
      place: clean(row.client_place, 80) || null,
      createdAt: row.created_at,
      current: Boolean(currentHash) && row.token_hash === currentHash,
    }));
}

export function isMissingSessionColumn(error: { message?: string; code?: string } | null | undefined): boolean {
  const code = String(error && error.code ? error.code : '');
  const message = String(error && error.message ? error.message : '');
  return code === '42703' || code === 'PGRST204' || /client_label|client_place/.test(message);
}
