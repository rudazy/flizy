/**
 * Request plumbing shared by the /api/mints routes: the JSON body, the
 * collection in the path, and the one error response shape. The field
 * validators live in web/lib/mintInput.ts (pure, so tests load it) and are
 * re-exported here for the routes.
 */

import { NextResponse } from 'next/server';
import { ClientError, clientMessage } from './apiError';
import { MintError } from './mintExecute.ts';
import { checkAddress } from './nftIndex.ts';
import { InputError } from './mintInput.ts';

export { artworkUrl, chainText, ethToWei, intField, pageText, timeField } from './mintInput.ts';

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  const raw = await req.json().catch(() => null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new MintError('Invalid request');
  return raw as Record<string, unknown>;
}

export function field(body: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(body, key) ? body[key] : undefined;
}

export function routeCollection(raw: string | undefined): string {
  const address = checkAddress(raw);
  if (!address) throw new MintError('Choose a collection.', 404);
  return address;
}

/**
 * The response for an error written for the person (InputError, MintError,
 * ClientError), or null when the error is internal and the route must answer
 * with apiErrorBody, which logs it and says only "Something went wrong".
 */
export function clientErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof InputError) return NextResponse.json({ error: err.message }, { status: 400 });
  if (err instanceof MintError) {
    return NextResponse.json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, { status: err.status });
  }
  if (err instanceof ClientError) return NextResponse.json({ error: clientMessage(err) }, { status: 400 });
  return null;
}
