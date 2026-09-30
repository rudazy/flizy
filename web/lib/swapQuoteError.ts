/**
 * Turn a quote failure into product copy.
 *
 * The words are written here. A route must not forward a provider message:
 * those carry hosts and call data.
 */

import { ClientError } from './apiError.ts';

export function asSwapQuoteError(err: unknown): ClientError | null {
  if (err instanceof ClientError) return err;
  const message = err instanceof Error ? err.message : '';
  if (message === 'Cannot swap a token for itself') {
    return new ClientError('That token is ETH on this chain. There is nothing to swap.');
  }
  if (message === 'Token decimals could not be read') {
    return new ClientError('That token could not be read.');
  }
  const code = err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : '';
  if (code === 'CALL_EXCEPTION') return new ClientError('No ETH pool for that token.');
  return null;
}
