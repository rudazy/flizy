# Flizy contracts

DEX (Uniswap V2 port + FlizyFeeRouter) is live on GIWA Sepolia. Addresses:
`deployments/giwa-sepolia.json`.

`src/dex/FlizyToken.sol` backs IZY and MAKI: fixed supply minted once, no owner, no mint,
no fee. `src/dex/FlizyTestUSD.sol` backs tUSD the same way, with 6 decimals.
`script/DeployListings.s.sol` deployed IZY and MAKI and seeded the DCAT, IZY and MAKI
WETH pools; `script/DeployTestUSD.s.sol` deployed tUSD and seeded its pool. All are recorded
under `listings`.

`src/pay/FlizyPaymentReceiver.sol` lets an outside wallet pay a Flizy account or a
checkout: it forwards every payment to the payee in the same transaction, keeps nothing
and has no owner.

The marketplace, drop and collection factory are deployed and verified, and paused in the
app (`FEATURE_NFT_MARKET`, `FEATURE_NFT_MINT`).

Test NFT collection (identity send only): `deployments/giwa-sepolia-nfts.json`.
Ticker `giwaforge`, cap 500, address `0xa613FcF6FE09442391b07F87b82c24a539bCCB2A`.
Public claim is one NFT per wallet (`claim` / chat `mint 1 giwaforge`, refused while minting
is paused). Owner `claimTo` fronts gas when the user has no ETH. Not the collections studio.

`FlizyWallet.sol` / `FlizyWalletFactory.sol` are scaffold. **Do not extend.
Do not deploy for users.** Live user wallets are MetaMask delegation-framework smart
accounts (HybridDeleGator, `deployments/giwa-sepolia-delegation.json`), still owned by a
key Flizy derives.

## Tooling

Foundry (Solidity). Do not implement mainnet custody in the bot as "hack-proof" EOAs.
