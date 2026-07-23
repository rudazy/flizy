# Flizy swap fees (GIWA Sepolia)

## What you pay

1. **Protocol fee (Flizy):** default **0.30%** (30 basis points) of the amount you put in.
   - Taken by `FlizyFeeRouter` before the swap is sent to the Uniswap V2-style router.
   - Paid to the Flizy treasury address.
   - Hard maximum in the contract: **1.00%** (100 bps). Owner can lower or raise only up to that cap.
2. **Pool fee (Uniswap V2 style):** **0.30%** inside the pair (standard constant-product AMM).
3. **Network gas:** paid from your agent wallet in native ETH.

## Where the fee is shown

- WhatsApp: every swap plan lists fee percentage and estimated fee amount before `confirm`.
- Site Swap screen: fee line is always visible on the quote before you confirm.
- This document.

## What does not count

- Swaps do **not** use trusted-contact checks (destination is an allowlisted router).
- Swaps do **not** count against the daily **send** limit (you keep the value in your agent wallet as another asset).
- Transfers and claim payouts still use trusted contacts and daily send limits as before.

## Liquidity

- Adding and removing liquidity is **site only** (Swap → + Liquidity → Add / Remove).
- No protocol fee on add or remove; you still pay gas.
- Remove burns FLZ-LP from your agent wallet and returns proportional ETH + FLZ.

## Addresses

See `deployments/giwa-sepolia.json` for factory, V2 router, fee router, WETH, FLZ, and pair.
