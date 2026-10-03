# Privy owner spike

Research only. Tests whether a Privy wallet can be the EOA owner of a
HybridDeleGator (MetaMask delegation-framework v1.3.0) on GIWA Sepolia
(chain 91342), sign the bounded delegation to Flizy, revoke it, and exit
with the account address unchanged. Throwaway accounts and testnet amounts
only. Nothing here is imported by `web/` or `lib/`. Results: `RESULTS.md`.

## Layout

- `server/chain.cjs`: addresses, EIP-712 types, UserOp building and submit.
- `server/steps.cjs`: steps S1 to S9. Holds the throwaway keys.
- `server/headless.cjs`: runs S1 and S3 to S8 with a Privy server wallet
  (created through the Privy wallet API, owned by a local P-256
  authorization key) as the owner. Privy only signs; the relayer submits.
- `server/privyApi.cjs`: the Privy wallet API calls the headless runner
  uses, including the `privy-authorization-signature` header.
- `server/server.cjs`: local step server on `127.0.0.1:5175` for the page.
  POSTs are accepted only from the page origin.
- `server/rehearse.cjs`: runs S1 to S8 with a local key standing in for
  Privy, on its own gator and `state.rehearsal.json`, then sweeps the funds
  back. It proves the Node side only.
- `server/results.cjs`: writes `RESULTS.md` from `state.json`.
- `src/main.js`, `index.html`, `vite.config.js`: the Privy page on
  `http://localhost:5174` for the browser run (email login, embedded
  wallet, S9 with MetaMask). It only signs what the server asks for.

`state.json` and `state.rehearsal.json` hold public testnet data only:
addresses, transaction hashes, signatures and results.

## Secrets

`.env.spike` is gitignored (`spikes/**/.env.spike`) and holds:

- `SPIKE_FUNDER_KEY`, `SPIKE_OWNER_KEY`, `SPIKE_DELEGATE_KEY`,
  `SPIKE_REHEARSAL_KEY`: throwaway testnet keys, created by the scripts.
- `PRIVY_APP_ID`, `PRIVY_APP_SECRET`: used only by the headless runner, in
  Node, as Basic auth to the Privy API.
- `PRIVY_AUTH_KEY`: the authorization private key (base64 PKCS#8) that owns
  the Privy server wallet. Created by the headless runner.
- `PRIVY_WALLET_ID`: the Privy server wallet's API id.
- `VITE_PRIVY_APP_ID`: the Privy app id for the page. Public by design; the
  only value that reaches the browser bundle.

## Run (Windows CMD, from the repo root)

```
cd spikes\privy-owner
npm install --ignore-scripts
```

Headless (S1, S3 to S8):

```
npm run headless
```

Browser (S1 to S9), in two windows:

```
npm run server
npm run page
```

Then open `http://localhost:5174`, log in with email, and run the steps in
order. For S9, connect MetaMask, which needs a little GIWA Sepolia ETH for gas.
A browser run needs a fresh gator; the headless run already moved ownership
of the current one.
