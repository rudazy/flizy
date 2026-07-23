/**
 * One-shot diagnostic: pending claims vs whatsapp_identities (masked).
 * Usage: node scripts/inspect-claim-mismatch.js
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

function mask(s) {
  const t = String(s || '');
  if (!t) return null;
  if (t.length <= 4) return '****';
  return `${t.slice(0, 3)}…${t.slice(-2)} (len=${t.length})`;
}

function looksLikePhone(s) {
  const t = String(s || '');
  // E.164-ish: 10-15 digits, typically starts with country code not LID-scale
  return /^\d{10,15}$/.test(t);
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
  if (!url || !key) {
    console.log('MISSING_SUPABASE_CREDS');
    process.exit(0);
  }
  const sb = createClient(url, key);

  const { data: claims, error: e1 } = await sb
    .from('claims')
    .select('id,to_wa_hint,status,from_wa_sender,created_at,to_account_id')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(10);
  if (e1) {
    console.log('CLAIMS_ERR', e1.message);
    return;
  }

  console.log(
    'PENDING_CLAIMS',
    JSON.stringify(
      (claims || []).map((c) => ({
        id: c.id.slice(0, 8),
        status: c.status,
        to_wa_hint: mask(c.to_wa_hint),
        to_hint_is_phone: looksLikePhone(c.to_wa_hint),
        from_wa_sender: mask(c.from_wa_sender),
        from_is_phone: looksLikePhone(c.from_wa_sender),
      })),
      null,
      2
    )
  );

  const { data: ids, error: e2 } = await sb
    .from('whatsapp_identities')
    .select('id,wa_sender_id,wa_phone_e164,account_id,linked_at')
    .order('linked_at', { ascending: false })
    .limit(15);
  if (e2) {
    console.log('IDS_ERR', e2.message);
    return;
  }

  console.log(
    'IDENTITIES',
    JSON.stringify(
      (ids || []).map((i) => ({
        id: i.id.slice(0, 8),
        wa_sender_id: mask(i.wa_sender_id),
        sender_is_phone: looksLikePhone(i.wa_sender_id),
        sender_len: String(i.wa_sender_id || '').length,
        wa_phone_e164: i.wa_phone_e164 ? mask(i.wa_phone_e164) : null,
        has_phone: Boolean(i.wa_phone_e164),
      })),
      null,
      2
    )
  );

  // Would listIncomingPending(sender) find any claim?
  for (const id of ids || []) {
    const sid = String(id.wa_sender_id || '');
    const matchBySender = (claims || []).filter((c) => c.to_wa_hint === sid);
    const matchByPhone = id.wa_phone_e164
      ? (claims || []).filter((c) => c.to_wa_hint === String(id.wa_phone_e164).replace(/\D/g, ''))
      : [];
    console.log(
      JSON.stringify({
        identity: mask(sid),
        claims_match_on_sender_id: matchBySender.length,
        claims_match_on_stored_phone: matchByPhone.length,
      })
    );
  }
}

main().catch((e) => {
  console.log('ERR', e.message);
  process.exit(1);
});
