const crypto = require('crypto');
const { getSupabase } = require('./supabase');
const { config } = require('./config');

function newClaimToken() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * @param {{ fromAccountId: string, toWaHint?: string, amountEth: string|number, chainId: number }} p
 */
async function createClaim(p) {
  const supabase = getSupabase();
  const claim_token = newClaimToken();
  const { data, error } = await supabase
    .from('claims')
    .insert({
      from_account_id: p.fromAccountId,
      to_wa_hint: p.toWaHint || null,
      amount_eth: p.amountEth,
      chain_id: p.chainId,
      claim_token,
      status: 'pending',
    })
    .select('*')
    .single();
  if (error) throw new Error(error.message);

  const claimUrl = `${config.siteUrl}/claim/${claim_token}`;
  return { claim: data, claimUrl };
}

async function getClaimByToken(token) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('claims')
    .select('*')
    .eq('claim_token', token)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

module.exports = {
  createClaim,
  getClaimByToken,
  newClaimToken,
};
