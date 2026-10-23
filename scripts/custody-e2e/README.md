# Custody checks on a local GIWA fork

Two checks for Secure your wallet, both on a local anvil fork of GIWA Sepolia.
Nothing here sends to the live network: the dev ops key is the same key that
submits live UserOps, so a live run could race them for nonces.

- **Browser walk**: real Chrome with a virtual passkey clicks through Account >
  Security against the dev server and the dev database, then `verify.cjs` checks
  the database rows and the chain directly.
- **Recovery check**: `remove-key-fork-check.cjs` runs
  `scripts/custody-remove-key.js` against a throwaway account and proves the
  passkey comes off and its permissions stop working.

Run state (`state.json`, `delegate.txt`, screenshots) is written next to these
files and is gitignored. It holds a throwaway dev account's session; `account.mjs
remove` deletes the account and that state.

## Before you start

- Foundry's `anvil` (if it is not on PATH, use `%USERPROFILE%\.foundry\bin\anvil`),
  and the root and `web/` dependencies installed.
- `.env.dev` (dev database target) and `web/.env.local` pointing at that same
  dev database. `account.mjs` refuses to run otherwise.
- The custody migration applied on dev.
- `E2E_CHROME` set to a Chrome or Chromium executable (for the browser walk).

Every command below runs from the repository root, in Windows CMD.

## Recovery check

Terminal 1:

```
anvil --fork-url https://sepolia-rpc.giwa.io --port 8546
```

Terminal 2:

```
node scripts\custody-e2e\remove-key-fork-check.cjs
```

## Browser walk

Terminal 1, the fork:

```
anvil --fork-url https://sepolia-rpc.giwa.io --port 8546
```

Terminal 2, a throwaway dev account, funded on the fork:

```
node scripts\custody-e2e\account.mjs create && node scripts\custody-e2e\fund.cjs
```

Terminal 3, the dev server pinned to the fork. Copy the account id with the
first line, then start it from `web\`:

```
for /f "delims=" %i in ('node -p "require('./scripts/custody-e2e/state.json').id"') do set E2E_PILOT=%i
set /p E2E_DELEGATE=<scripts\custody-e2e\delegate.txt
set E2E_FORK_RPC=http://127.0.0.1:8546
set PORT=3100
set NODE_OPTIONS=-r %CD%\scripts\custody-e2e\pin-env.cjs
cd web && node node_modules\next\dist\bin\next dev -p 3100
```

Terminal 2 again, the walk and the independent checks:

```
set E2E_CHROME=<path to chrome.exe>
node scripts\custody-e2e\walk.mjs && node scripts\custody-e2e\verify.cjs
```

The first dev compile of the dashboard can take a few minutes; the walk waits.

Clean up, then stop terminals 1 and 3:

```
node scripts\custody-e2e\account.mjs remove
```
