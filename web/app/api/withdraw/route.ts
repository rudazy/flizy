import { NextResponse } from 'next/server';

/**
 * Site free-form withdraw is disabled.
 * Allowlist thesis: funds leave only via WhatsApp to trusted destinations
 * (or claim/escrow flows). Password alone must never unlock "any 0x".
 */
export async function POST() {
  return NextResponse.json(
    {
      error:
        'Site withdraw is disabled. Send from WhatsApp to a trusted address only: flizy send 0.01 to name  ·  flizy send 10 FLZ to name',
      code: 'WITHDRAW_WHATSAPP_ONLY',
    },
    { status: 403 }
  );
}

export async function GET() {
  return NextResponse.json({
    enabled: false,
    message:
      'Withdrawals and sends run on WhatsApp to addresses on your trusted list. Site cannot send to arbitrary addresses.',
  });
}
