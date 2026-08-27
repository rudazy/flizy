# Flizy contracts

DEX (Uniswap V2 port + FlizyFeeRouter) is live on GIWA Sepolia. Addresses:
`deployments/giwa-sepolia.json`.

Test NFT collection (identity send only): `deployments/giwa-sepolia-nfts.json`.
Ticker `giwaforge`, cap 500, address `0xa613FcF6FE09442391b07F87b82c24a539bCCB2A`.
Public claim is one NFT per wallet (`claim` / chat `mint 1 giwaforge`).
Owner `claimTo` fronts gas when the user has no ETH. Not the collections studio.

`FlizyWallet.sol` / `FlizyWalletFactory.sol` are scaffold. **Do not extend.
Do not deploy for users.** Live user wallets today are server-derived EOAs.

## Tooling

Foundry (Solidity). Do not implement mainnet custody in the bot as "hack-proof" EOAs.
