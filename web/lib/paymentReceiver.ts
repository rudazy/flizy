/**
 * FlizyPaymentReceiver on GIWA Sepolia (deployments/giwa-sepolia.json,
 * "paymentReceiver"). Public, read by the browser to build the payment and by
 * the server to check the event came from it. test/externalPay.test.js keeps
 * it equal to the deployment record.
 *
 * Constants only, so the pay page can import this without pulling in viem.
 * The invoice id hash lives in invoiceId.ts, loaded when a payment starts.
 */
export const PAYMENT_RECEIVER = '0x12197866DdD74b0F37D2127AC5e2E69dFF6d6FF1';

/** The chain the receiver lives on. A wallet on any other chain is asked to switch first. */
export const PAYMENT_RECEIVER_CHAIN = {
  id: 91342,
  hexId: '0x164ce',
  name: 'GIWA Sepolia',
  rpcUrl: 'https://sepolia-rpc.giwa.io',
  explorerUrl: 'https://sepolia-explorer.giwa.io',
} as const;

export const INVOICE_NONCE_RE = /^0x[0-9a-f]{32}$/;
