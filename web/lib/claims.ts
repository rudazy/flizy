import { getSupabase } from './supabase';

export async function getClaimByToken(token: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('claims')
    .select('*')
    .eq('claim_token', token)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}
