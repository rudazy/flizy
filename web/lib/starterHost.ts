/**
 * Who a new account pays first in the starter pack, and how much. Kept apart
 * from starterPack.ts, which reads the database, so the Home card can import
 * these without pulling a server client into the browser bundle.
 */

export const STARTER_HOST = 'ludarep';
export const STARTER_AMOUNT_ETH = 0.001;
