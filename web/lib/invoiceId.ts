import { keccak256, stringToHex } from 'viem';

/**
 * The invoice id a payment through FlizyPaymentReceiver carries on chain: a
 * hash of the note and a random nonce the page picked. Whoever later confirms
 * the payment must present the same note and nonce, so a note cannot be pinned
 * onto somebody else's payment by a stranger who saw the transaction first.
 *
 * Its own module so the pay page loads viem only when a payment starts.
 */
export function invoiceIdFor(note: string | null, nonce: string): `0x${string}` {
  return keccak256(stringToHex(`flizy-pay:${nonce}:${note ?? ''}`));
}
