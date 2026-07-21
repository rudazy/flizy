# Flizy smart wallet (Phase 2)

Ludarep confirmed Phase 2.

Target: smart contract wallet per account with session keys.

## Goals

- Session key can swap on approved DEX routers.
- Session key can only transfer out to allowlisted addresses (on-chain).
- Deterministic deploy (CREATE2) so the address is identical on every EVM chain.

## Status

Scaffold only. Implementation starts after Phase 0 and Phase 1 land and the bot identity model is stable.

## Tooling

Foundry (Solidity). Do not implement mainnet custody in the bot as "hack-proof" EOAs.
