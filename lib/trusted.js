const { getSupabase } = require('./supabase');
const { ethers } = require('ethers');
const { config } = require('./config');

/**
 * @param {string} accountId
 * @returns {Promise<Array<{ address: string, label: string }>>}
 */
async function listTrusted(accountId) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('trusted_addresses')
    .select('address, label')
    .eq('account_id', accountId)
    .order('label', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

/**
 * @param {string} accountId
 * @param {string} address
 */
async function isTrustedAddress(accountId, address) {
  if (!ethers.isAddress(address)) return false;
  const checksum = ethers.getAddress(address);
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('trusted_addresses')
    .select('id')
    .eq('account_id', accountId)
    .ilike('address', checksum)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (data) return true;

  // Also accept exact lowercase match storage
  const { data: data2 } = await supabase
    .from('trusted_addresses')
    .select('id')
    .eq('account_id', accountId)
    .eq('address', checksum)
    .maybeSingle();
  return Boolean(data2);
}

/**
 * Site-only mutation helpers (used by web API, not WhatsApp).
 */
async function addTrusted(accountId, address, label) {
  if (!ethers.isAddress(address)) throw new Error('Invalid address');
  const checksum = ethers.getAddress(address);
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('trusted_addresses')
    .upsert(
      {
        account_id: accountId,
        address: checksum,
        label: label || '',
      },
      { onConflict: 'account_id,address' }
    )
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function removeTrusted(accountId, address) {
  if (!ethers.isAddress(address)) throw new Error('Invalid address');
  const checksum = ethers.getAddress(address);
  const supabase = getSupabase();
  const { error } = await supabase
    .from('trusted_addresses')
    .delete()
    .eq('account_id', accountId)
    .eq('address', checksum);
  if (error) throw new Error(error.message);
}

/**
 * Why the send was refused, and what to do about it.
 *
 * The rule itself stays in `config.rejectUntrustedCopy` so an operator can
 * reword it without a deploy. The route is appended here rather than baked into
 * that string, so a reworded rule cannot accidentally ship without one — the
 * old copy ended on "See site docs for details" and named no destination at
 * all, which is a dead end at the moment a send is refused.
 */
function rejectUntrustedMessage() {
  return [
    config.rejectUntrustedCopy,
    '',
    `Add them as trusted: ${config.siteUrl}/dashboard`,
    'Your password is needed to change the list.',
  ].join('\n');
}

module.exports = {
  listTrusted,
  isTrustedAddress,
  addTrusted,
  removeTrusted,
  rejectUntrustedMessage,
};
