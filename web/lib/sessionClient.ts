/**
 * What a site session may say about the browser that opened it.
 *
 * The label is a short browser and system name. The kind says phone, tablet or
 * computer, and the model is the handset model when the browser shares it. The
 * place is a city and country, from the device's time zone when the network's
 * place is in a different country, and from the host otherwise. None of these
 * values is an address, a user agent, or a token.
 */

import { placeFromTimeZone } from './timeZonePlace.ts';

const CONTROL = /[\u0000-\u001f\u007f]/g;

export type ClientKind = 'phone' | 'tablet' | 'computer';

export type SessionClient = {
  label: string | null;
  kind: ClientKind | null;
  model: string | null;
  place: string | null;
  /** The network's place, kept only when it disagrees with `place`. */
  networkPlace: string | null;
};

export type StoredSession = {
  id: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
  client_label?: string | null;
  client_place?: string | null;
  client_kind?: string | null;
  client_model?: string | null;
  client_network_place?: string | null;
  last_seen_at?: string | null;
};

export type PublicSession = {
  id: string;
  label: string | null;
  kind: ClientKind | null;
  model: string | null;
  place: string | null;
  networkPlace: string | null;
  createdAt: string;
  lastSeenAt: string | null;
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

/**
 * Phone, tablet or computer. `mobileHint` is the Sec-CH-UA-Mobile header,
 * which Chromium sends on every request: "?1" on a phone, "?0" otherwise.
 * An Android user agent without "Mobile" is a tablet by Google's own rule.
 */
export function clientKind(
  userAgent: string | null | undefined,
  mobileHint?: string | null
): ClientKind | null {
  const raw = String(userAgent || '').slice(0, 400);
  if (/iPad/.test(raw)) return 'tablet';
  if (/iPhone|iPod/.test(raw)) return 'phone';
  if (/Android/.test(raw)) return /Mobile/.test(raw) || mobileHint === '?1' ? 'phone' : 'tablet';
  if (mobileHint === '?1') return 'phone';
  if (/Windows|Mac OS X|CrOS|X11|Linux/.test(raw)) return 'computer';
  return null;
}

/** Model codes are letters, digits, and a little punctuation. */
const MODEL_SHAPE = /^[A-Za-z0-9][A-Za-z0-9 ._+()-]{0,39}$/;

function tidyModel(raw: unknown): string | null {
  const text = String(raw || '')
    .replace(CONTROL, '')
    .replace(/^"|"$/g, '')
    .trim();
  // Reduced Chrome user agents carry "K" in place of the model.
  if (!text || text === 'K' || !MODEL_SHAPE.test(text)) return null;
  // An SM- code is a Samsung, which the code alone does not tell most owners.
  return /^SM-/.test(text) ? `Samsung ${text}` : text;
}

/**
 * The handset model. `modelHint` is the Sec-CH-UA-Model header, which Chromium
 * sends only after the site asks for it (Accept-CH in next.config.mjs). Older
 * and non-Chromium Android browsers still put the model in the user agent.
 * iPhones never share one, and computers have none.
 */
export function clientModel(
  userAgent: string | null | undefined,
  modelHint?: string | null
): string | null {
  const hinted = tidyModel(modelHint);
  if (hinted) return hinted;
  const raw = String(userAgent || '').slice(0, 400);
  const match = /Android [\d.]+; (?:[a-z]{2}[-_][a-zA-Z]{2}; )?([^;)]+?)(?: Build\/[^;)]*)?\)/.exec(raw);
  return match ? tidyModel(match[1]) : null;
}

/** A country is two letters. A longer value is not cut down into a code. */
function countryCode(raw: unknown): string {
  const text = String(raw || '').replace(CONTROL, '').trim();
  return /^[A-Za-z]{2}$/.test(text) ? text.toUpperCase() : '';
}

function joinPlace(city: string, country: string): string | null {
  if (city && country) return `${city}, ${country}`;
  return city || country || null;
}

/**
 * City and country from the host, when it sets them. A caller-supplied copy of
 * these headers is only as trustworthy as the host. Vercel overwrites them.
 */
export function clientPlace(headers: Pick<Headers, 'get'>): string | null {
  return joinPlace(clean(headers.get('x-vercel-ip-city'), 40), countryCode(headers.get('x-vercel-ip-country')));
}

/**
 * Where to say the sign-in happened.
 *
 * Same country from the network and the time zone: the network's city, which
 * is the finer of the two. Different countries: the time zone's city and
 * country, with the network's place kept beside it. The time zone is set by
 * whoever holds the device, so the list always shows the network's answer too
 * when it differs. A time zone the map does not know changes nothing.
 */
export function placeFor(
  headers: Pick<Headers, 'get'>,
  timeZone?: string | null
): { place: string | null; networkPlace: string | null } {
  const network = clientPlace(headers);
  const zone = placeFromTimeZone(timeZone);
  if (!zone) return { place: network, networkPlace: null };
  const networkCountry = countryCode(headers.get('x-vercel-ip-country'));
  if (networkCountry === zone.country) return { place: network, networkPlace: null };
  return { place: joinPlace(zone.city, zone.country), networkPlace: network };
}

export function sessionClientFrom(headers: Pick<Headers, 'get'>, timeZone?: string | null): SessionClient {
  const userAgent = headers.get('user-agent');
  const mobileHint = headers.get('sec-ch-ua-mobile');
  return {
    label: clientLabel(userAgent),
    kind: clientKind(userAgent, mobileHint),
    model: clientModel(userAgent, headers.get('sec-ch-ua-model')),
    ...placeFor(headers, timeZone),
  };
}

const KINDS: ReadonlySet<string> = new Set(['phone', 'tablet', 'computer']);

/** Rows from before the kind column have only the label to go on. */
function kindOf(row: StoredSession): ClientKind | null {
  const stored = String(row.client_kind || '');
  if (KINDS.has(stored)) return stored as ClientKind;
  const label = String(row.client_label || '');
  if (/on (iPhone|Android)$/.test(label)) return 'phone';
  if (/on iPad$/.test(label)) return 'tablet';
  if (/on (Windows|Mac|Linux)$/.test(label)) return 'computer';
  return null;
}

function isoOrNull(raw: unknown): string | null {
  const text = String(raw || '');
  return text && !Number.isNaN(new Date(text).getTime()) ? text : null;
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
      kind: kindOf(row),
      model: tidyModel(row.client_model),
      place: clean(row.client_place, 80) || null,
      networkPlace: clean(row.client_network_place, 80) || null,
      createdAt: row.created_at,
      lastSeenAt: isoOrNull(row.last_seen_at),
      current: Boolean(currentHash) && row.token_hash === currentHash,
    }));
}

export function isMissingSessionColumn(error: { message?: string; code?: string } | null | undefined): boolean {
  const code = String(error && error.code ? error.code : '');
  const message = String(error && error.message ? error.message : '');
  return (
    code === '42703' ||
    code === 'PGRST204' ||
    /client_label|client_place|client_kind|client_model|client_network_place|last_seen_at/.test(message)
  );
}
