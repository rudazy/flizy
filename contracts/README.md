# Flizy contracts

DEX (Uniswap V2 port + FlizyFeeRouter) is live on GIWA Sepolia. Addresses:
`deployments/giwa-sepolia.json`.

`FlizyWallet.sol` / `FlizyWalletFactory.sol` are scaffold. **Do not extend.
Do not deploy for users.** Live user wallets today are server-derived EOAs.

## Tooling

Foundry (Solidity). Do not implement mainnet custody in the bot as "hack-proof" EOAs.
