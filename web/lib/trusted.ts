import { getSupabase } from './supabase';
import { ClientError } from './apiError';

function isAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function checksumLike(address: string): string {
  // ethers not required on site for storage; store lowercase-normalized hex with 0x
  return ('0x' + address.slice(2).toLowerCase()).replace(
    /^0x([a-f0-9]{40})$/,
    (_, h) => '0x' + h
  );
}

/**
 * The destinations to show, and whether each one can actually be used yet.
 *
 * `pending` is derived rather than stored: a row is held until `active_at`
 * passes, and nothing flips it, so there is no job to fail. Cancelled rows are
 * left out entirely; they exist only so the attempt stays on record.
 *
 * This is display. The rule that a held destination cannot receive funds is
 * enforced in lib/trusted.js `isTrustedAddress`, which is what the send policy
 * calls. Filtering here would not stop a send.
 */
export async function listTrusted(accountId: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('trusted_addresses')
    .select('address, label, status, active_at')
    .eq('account_id', accountId)
    .eq('status', 'active')
    .order('label', { ascending: true });
  if (error) throw new Error(error.message);

  const now = Date.now();
  return (data || []).map((row) => ({
    address: row.address,
    label: row.label,
    pending: new Date(row.active_at).getTime() > now,
    activeAt: row.active_at,
  }));
}

export async function addTrusted(accountId: string, address: string, label: string) {
  // ClientError: written for whoever typed it, so the route may pass it through.
  if (!isAddress(address)) throw new ClientError('Invalid address');
  // Preserve original casing for display; uniqueness is case-insensitive via app checks
  const normalized = '0x' + address.slice(2);
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('trusted_addresses')
    .upsert(
      {
        account_id: accountId,
        address: normalized,
        label: label || '',
        // Stated, not implied. Adding a destination that was previously
        // cancelled lands on the existing row as an update, and without this it
        // would stay cancelled and unusable while the add reported success. The
        // database sees the cancelled -> active transition and re-applies the
        // 24 hour hold, so re-adding is never a way to skip one.
        status: 'active',
      },
      { onConflict: 'account_id,address' }
    )
    .select('address, label')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function removeTrusted(accountId: string, address: string) {
  // ClientError: written for whoever typed it, so the route may pass it through.
  if (!isAddress(address)) throw new ClientError('Invalid address');
  const normalized = '0x' + address.slice(2);
  const supabase = getSupabase();
  const { error } = await supabase
    .from('trusted_addresses')
    .delete()
    .eq('account_id', accountId)
    .eq('address', normalized);
  if (error) throw new Error(error.message);
}

// silence unused if tree-shaken
void checksumLike;
