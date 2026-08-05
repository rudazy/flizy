/**
 * List / add / remove secondary emails for the signed-in account.
 *
 * Registration email (accounts.email) is always claimable and is not managed here.
 * Secondary emails are claimable only after verified_at is set (magic-link later).
 */

import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { parseEmail, isValidEmail, normalizeEmail } from '../../../../lib/email';
import { verifyPassword } from '../../../../lib/cryptoPin';
import { apiErrorBody } from '../../../../lib/apiError';

const ROUTE = '/api/account/emails';

async function listEmails(accountId: string) {
  const supabase = getSupabase();
  const { data: acc, error: aErr } = await supabase
    .from('accounts')
    .select('email')
    .eq('id', accountId)
    .maybeSingle();
  if (aErr) throw new Error(aErr.message);
  const primary = parseEmail(acc?.email);

  const { data: rows, error: eErr } = await supabase
    .from('account_emails')
    .select('id, email, verified_at, created_at')
    .eq('account_id', accountId)
    .order('created_at', { ascending: true });

  if (eErr) {
    if (String(eErr.message || '').includes('account_emails') || eErr.code === '42P01') {
      return {
        primary,
        additional: [] as Array<{
          id: string;
          email: string;
          verified: boolean;
          verifiedAt: string | null;
          createdAt: string | null;
        }>,
        claimable: primary ? [primary] : [],
      };
    }
    throw new Error(eErr.message);
  }

  const additional = (rows || []).map((r) => ({
    id: String(r.id),
    email: normalizeEmail(r.email),
    verified: Boolean(r.verified_at),
    verifiedAt: r.verified_at ? String(r.verified_at) : null,
    createdAt: r.created_at ? String(r.created_at) : null,
  }));

  const claimable = [...(primary ? [primary] : [])];
  for (const row of additional) {
    if (row.verified && !claimable.includes(row.email)) claimable.push(row.email);
  }

  return { primary, additional, claimable };
}

export async function GET() {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }
    const data = await listEmails(accountId);
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(apiErrorBody(`GET ${ROUTE}`, err), { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const email = parseEmail(body.email);
    const password = String(body.password || '');

    if (!email || !isValidEmail(email)) {
      return NextResponse.json({ error: 'Invalid email address.' }, { status: 400 });
    }
    if (!password) {
      return NextResponse.json({ error: 'Password is required to add an email.' }, { status: 400 });
    }

    const supabase = getSupabase();
    const { data: acc, error: aErr } = await supabase
      .from('accounts')
      .select('email, password_hash')
      .eq('id', accountId)
      .maybeSingle();
    if (aErr) throw new Error(aErr.message);
    if (!acc) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }
    if (!verifyPassword(password, acc.password_hash)) {
      return NextResponse.json({ error: 'Incorrect password.' }, { status: 401 });
    }
    if (parseEmail(acc.email) === email) {
      return NextResponse.json(
        { error: 'That is already your registration email.' },
        { status: 400 }
      );
    }

    const { data: takenPrimary } = await supabase
      .from('accounts')
      .select('id')
      .eq('email', email)
      .maybeSingle();
    if (takenPrimary?.id && takenPrimary.id !== accountId) {
      return NextResponse.json(
        { error: 'That email is already registered to another Flizy account.' },
        { status: 409 }
      );
    }

    const { data, error } = await supabase
      .from('account_emails')
      .insert({
        account_id: accountId,
        email,
        verified_at: null,
      })
      .select('id, email, verified_at, created_at')
      .single();

    if (error) {
      if (error.code === '23505') {
        return NextResponse.json(
          { error: 'That email is already on a Flizy account.' },
          { status: 409 }
        );
      }
      return NextResponse.json(apiErrorBody(`POST ${ROUTE}`, error), { status: 500 });
    }

    const list = await listEmails(accountId);
    return NextResponse.json({
      email: {
        id: data.id,
        email: normalizeEmail(data.email),
        verified: false,
        verifiedAt: null,
        createdAt: data.created_at,
      },
      ...list,
      note: 'Additional emails must be verified before they can receive claims. Registration email already can.',
    });
  } catch (err) {
    return NextResponse.json(apiErrorBody(`POST ${ROUTE}`, err), { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const emailId = String(body.id || body.emailId || '').trim();
    if (!emailId) {
      return NextResponse.json({ error: 'Missing email id.' }, { status: 400 });
    }

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('account_emails')
      .delete()
      .eq('id', emailId)
      .eq('account_id', accountId)
      .select('id')
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) {
      return NextResponse.json({ error: 'Email not found on this account.' }, { status: 404 });
    }

    const list = await listEmails(accountId);
    return NextResponse.json({ ok: true, ...list });
  } catch (err) {
    return NextResponse.json(apiErrorBody(`DELETE ${ROUTE}`, err), { status: 500 });
  }
}
