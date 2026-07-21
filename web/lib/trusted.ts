import { getSupabase } from './supabase';

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

export async function listTrusted(accountId: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('trusted_addresses')
    .select('address, label')
    .eq('account_id', accountId)
    .order('label', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function addTrusted(accountId: string, address: string, label: string) {
  if (!isAddress(address)) throw new Error('Invalid address');
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
      },
      { onConflict: 'account_id,address' }
    )
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function removeTrusted(accountId: string, address: string) {
  if (!isAddress(address)) throw new Error('Invalid address');
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
