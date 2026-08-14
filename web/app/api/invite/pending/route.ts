import { NextResponse } from 'next/server';
import { readInviteCookie } from '../../../../lib/inviteCookie.ts';

/** Public username from the invite cookie so signup can show it. */
export async function GET() {
  try {
    return NextResponse.json({ code: readInviteCookie() });
  } catch {
    return NextResponse.json({ code: null });
  }
}
