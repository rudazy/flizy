import { createHmac } from 'crypto';
import { secretMatches } from './bearerSecret.ts';

/**
 * Whether a Nodit webhook message carries a valid x-signature: the hex
 * HMAC-SHA256 of the body under the webhook's signing key.
 *
 * Nodit's documented check hashes JSON.stringify of the parsed body; the raw
 * bytes are accepted too, in case they are what was signed. Both comparisons
 * are constant time. An unset key or a missing header refuses.
 */
export function noditSignatureOk(raw: string, signature: string | null, key: string | undefined): boolean {
  if (!key || !signature) return false;
  const offered = signature.trim().toLowerCase();
  const sign = (text: string) => createHmac('sha256', key).update(text, 'utf8').digest('hex');
  if (secretMatches(offered, sign(raw))) return true;
  try {
    return secretMatches(offered, sign(JSON.stringify(JSON.parse(raw))));
  } catch {
    return false;
  }
}
