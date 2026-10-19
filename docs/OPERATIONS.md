# Operations

Internal runbook for people who run Flizy: setup, deployment, configuration and the
engineering rules the code is held to. Product overview lives in the
[README](../README.md). Implementation detail lives in [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Prerequisites

- Node.js **18+** (22+ recommended)
- Supabase project
- A WhatsApp account for the bot number (linked device)
- A Telegram bot token from @BotFather
- Foundry, optional, only for contracts

---

## Setup

### WhatsApp client (local or server)

```bash
cd /path/to/flizy
cp .env.example .env
# fill SUPABASE_*, GIWA_RPC, PRIVATE_KEY, BOT_WHATSAPP_NUMBER
# SITE_URL=https://flizy.app
npm install
node index.js
```

First run prints a QR code. Scan it from WhatsApp under Linked devices.

### Telegram client

Separate process, same code, same database, same wallets:

```bash
cp .env.example .env
# add TELEGRAM_BOT_TOKEN (from @BotFather) and TELEGRAM_BOT_USERNAME
node telegram.js
```

Long polling, so no public URL and no inbound port is required. Only one process may poll a
token at a time. A second poller makes Telegram answer 409 and both stall, so never run
`node telegram.js` by hand while the service is active.

Switching to webhooks later would need a public HTTPS endpoint (nginx plus certbot),
`setWebhook` with a secret token, and verification of the
`X-Telegram-Bot-Api-Secret-Token` header on every request. No application code changes.

### Site

```bash
cd web
npm install
npm run dev
```

Production: deploy `web/` to Vercel. Set `TELEGRAM_BOT_USERNAME` there too, or the Telegram
deep-link button will not render on the dashboard.

### Database

Migrations in `supabase/migrations/` are applied by hand, in timestamp order. Never run
`supabase db push` from this folder: it is CLI-linked to the production project and applies
pending migrations with no confirmation.

- **Dev:** the guarded runner, which reads only `.env.dev` and refuses any project not
  declared as dev in two places.

  ```cmd
  node scripts\run-dev-migrations.js --dry-run --only FILE.sql
  node scripts\run-dev-migrations.js --confirm --only FILE.sql
  node scripts\verify-dev-schema.js
  ```

- **Production:** paste the file into the Supabase dashboard SQL Editor after confirming the
  project ref in the browser URL. Each migration ends with a post-condition block that
  raises if an expected object is missing.

Apply a migration to production before deploying code that needs it. The site build runs
`web/scripts/verify-schema.mjs` and refuses to build while an object the code reads is
missing.

### Contracts

```bash
cd contracts
forge install foundry-rs/forge-std
forge test
# redeploy DEX only if needed:
# node ../scripts/deploy-dex.js
```

Verification against the GIWA Sepolia Blockscout explorer, per contract:

```bash
forge verify-contract <address> src/dex/<File>.sol:<Contract> \
  --chain-id 91342 \
  --compiler-version 0.8.24+commit.e11b9ed9 \
  --num-of-optimizations 200 \
  --constructor-args <abi encoded args> \
  --verifier blockscout \
  --verifier-url "https://sepolia-explorer.giwa.io/api/"
```

No API key is required. Constructor arguments per contract are recorded in
`deployments/giwa-sepolia.json` under `verification.constructorArgs`.

### Listing a token

`script/DeployListings.s.sol` deployed IZY and MAKI and seeded the DCAT, IZY and MAKI
pools. It is a record of that run, not a reusable tool: it refuses to seed a pool that
already exists. To list another token:

1. Seed its WETH pool through the V2 router at the price of any other market it has, or
   arbitrage drains the gap. Rehearse the broadcast on an anvil fork first.
2. The deployer key also submits live user operations, so a broadcast can lose a nonce
   to it. After any failure, read the nonce, receipts and pair reserves before resending.
3. Record the token under `listings` in `deployments/giwa-sepolia.json`, add it to both
   `lib/listedTokens.js` and `web/lib/listedTokens.ts` with a logo in `web/public/tokens/`
   (the token's own art, or a mark drawn in the palette), and run `node --test test/listedTokensDrift.test.js test/tokenLogos.test.js`.
4. Pull and restart the chat services so chat resolves the new symbol.

### Featuring a task

A Flizy admin (`accounts.is_admin`) sees **Feature on Explore** at the bottom of any task
page. Featured tasks carry a Featured badge and list first on Explore; the same button
takes the mark off. The route checks the admin flag before it writes `tasks.featured_at`,
so no creator can feature their own task.

---

## Deployment (systemd)

Two units, one codebase, one `.env`:

| Unit | Process | Notes |
| --- | --- | --- |
| `flizy.service` | `node index.js` (WhatsApp) | Drives headless Chromium |
| `flizy-telegram.service` | `node telegram.js` (Telegram) | HTTPS long polling, no browser |

They are deliberately separate processes. WhatsApp runs a headless Chromium and is the
fragile half: session loss, relink prompts, memory pressure. A Chromium failure must not
take Telegram payments offline as well, and a Telegram restart must not disturb a healthy
WhatsApp session.

### Install

```bash
cd /opt/flizy
git pull
npm install --omit=dev

sudo cp deploy/flizy.service /etc/systemd/system/flizy.service
sudo cp deploy/flizy-telegram.service /etc/systemd/system/flizy-telegram.service
sudo systemctl daemon-reload
sudo systemctl enable flizy flizy-telegram
sudo systemctl start flizy flizy-telegram
```

### Deploy an update

```bash
cd /opt/flizy && git pull && npm install --omit=dev
sudo systemctl restart flizy flizy-telegram
```

### Status and logs

```bash
systemctl status flizy --no-pager
systemctl status flizy-telegram --no-pager
journalctl -u flizy -f
journalctl -u flizy-telegram -f
```

### Cautions

- **Never run the same WhatsApp session in two places at once.** A local run and the server
  run will fight over the linked device and one will be logged out.
- An orphaned headless Chromium can keep holding the session profile and cause
  "The browser is already running for ...`.wwebjs_auth/session`". Stop the stale browser
  processes before restarting.
- Only one process may poll a Telegram bot token. Stop the service before running the
  client by hand.

See also [`deploy/README-systemd.md`](../deploy/README-systemd.md).

---

## Environment

Copy `.env.example` to `.env` and fill it. Never commit a real `.env`.

| Variable | Purpose |
|----------|---------|
| `SUPABASE_URL` / `SUPABASE_KEY` | Database (service role on the bot host) |
| `SUPABASE_DB_PASSWORD` | Direct Postgres connection for migration scripts |
| `GIWA_RPC` | GIWA Sepolia RPC endpoint |
| `WALLET_DERIVATION_SECRET` | Required, min 32 chars. Keys every agent wallet. Same value on the VPS and on Vercel. See below |
| `PRIVATE_KEY` | Ops hot wallet. Pays gas, and owns the fee router. Not the fee destination |
| `ESCROW_PRIVATE_KEY` | Optional dedicated claim escrow key |
| `BOT_WHATSAPP_NUMBER` | Digits for `wa.me` deep links |
| `TELEGRAM_BOT_TOKEN` | Telegram client. Never commit it, never log it |
| `TELEGRAM_BOT_USERNAME` | Bot username, no `@`, for `t.me/…?start=CODE` links. Also set on Vercel |
| `TELEGRAM_POLL_TIMEOUT_SEC` | Long poll wait, default 30 |
| `OUTBOX_DRAIN_MS` | Notification outbox poll, default 5000. Worst case delay for a cross-channel notice |
| `SITE_URL` | Public site URL. Production: `https://flizy.app` (also set `NEXT_PUBLIC_SITE_URL` on Vercel) |
| `ADMIN_PHONES` / `ADMIN_SETUP_SECRET` | Retired. Admin is `accounts.is_admin`, set by hand in the SQL editor. The bots warn at startup if either is still set |
| `ENFORCE_TRUSTED` | Approved-destination enforcement on transfers. Keep `true`; the bots report `false` to Sentry at startup in production |
| `ENFORCE_CREDIT` | Require internal credit before a send |
| `REQUIRE_UNLOCK` | Chat moves money only after a PIN unlock. Keep `true`; the bots report `false` to Sentry at startup in production |
| `SECURITY_MAIL_SECRET` | Same value on the VPS and on Vercel. Lets a bot ask the site to email the owner when a chat is linked or unlinked. Unset: no email, reported at startup in production |
| `REQUIRE_FLIZY_PREFIX` | Require the `flizy` prefix on WhatsApp |
| `MAX_SEND_ETH` / `DEFAULT_DAILY_SEND_LIMIT_ETH` | Per-transaction and per-day caps |
| `DEFAULT_QUICK_SEND_ETH` | Most one ETH payment to a known recipient may be without the PIN (default 0.005), and the ceiling on an account's own value. Set the same on the VPS and on Vercel |
| `PENDING_TTL_MS` / `LINK_CODE_TTL_MS` | Plan and link code lifetimes |
| `SESSION_TTL_MS` / `SESSION_MAX_MS` | Chat unlock: ends after this long without a message (default 30 min), and never later than this after the PIN was entered (default 8 h) |
| `SWAP_FEE_BPS` / `SWAP_SLIPPAGE_BPS` | Defaults for display and quotes. Slippage above 500 (5%) is cut to 500 by every quote; an unreadable value is 100 |
| `CHAIN_GIWA_SEPOLIA_*` | Optional overrides for WETH, routers, FLZ, pair |
| `FLIZY_TREASURY` | Treasury passed at DEX deploy time (defaults to ops). The live fee destination is `feeRouter.treasury` on chain, changed with `setTreasury`, not with this variable |
| `GAS_BUFFER_ETH` | Reserve kept for gas when checking funding |
| `AMMORA_ENABLED` | Ammora venue, bots and site server. Default off; off loads nothing and reads nothing. See [Ammora venue](#ammora-venue) |
| `NEXT_PUBLIC_AMMORA_ENABLED` | Vercel only. Shows the Ammora launches view in Explore. Trade opens the token page, where Buy uses the Ammora venue. Default off |
| `AMMORA_DATA_API_URL` | Ammora Data API for launch status. Defaults to `https://ammora-giwa-sepolia-data.fly.dev` |

Treat `PRIVATE_KEY`, escrow keys and Supabase service keys as production secrets. Rotate
immediately if one is exposed.

### Ammora venue

Ammora is a separate swap venue on GIWA Sepolia, reached through `@ammora-protocol/sdk`
(pinned, loaded only when `AMMORA_ENABLED=true`). Flizy's own executor sends every Ammora
swap; the SDK only quotes and builds the call.

- **Trust anchor.** `deployments/ammora-giwa-sepolia.json` pins each Ammora contract's
  address and runtime code hash. It is self-attested (written by `scripts/ammora-pin.js`,
  not signed by Ammora). The bots check it at start and hourly; the site checks it every
  10 minutes and warns at prebuild (`web/scripts/verify-ammora.mjs`). A mismatch turns the
  Ammora venue off and nothing else. Regenerate it with `node scripts/ammora-pin.js` after an
  SDK upgrade, and review the diff.
- **Inventory.** The WhatsApp bot scans the pinned factory for pools and stores them in
  `ammora_pools` every 10 minutes (the SDK only routes pools with on-chain provenance). The
  first scan takes a few minutes. The site and the Telegram bot read that table.
- **Rules.** Flizy symbols always win: an Ammora token with a Flizy symbol is reached by
  contract address only. Every Ammora trade takes the PIN, pays no Flizy fee, and does not
  count against the daily send limit. Approvals are for the exact amount, reset to zero
  first when an allowance is already there. Every swap is a call to the pinned aggregation
  router only, and its calldata is decoded and checked before sending: paid to the account's
  own smart account, the quoted amounts, no referrer or integrator fee, and only pools
  discovered from the pinned factory.
- **Schema.** `supabase/migrations/20261016140000_ammora_venue.sql` must be applied before
  this code is deployed, even with the flag off: the bots' startup schema check requires
  `ammora_pools` and `ammora_scan_state`.
- **Turning it on.** Apply the migration, deploy, restart both bots with
  `AMMORA_ENABLED=true`, wait for the first inventory pass in the WhatsApp journal
  (`[ammora] inventory`), then set `AMMORA_ENABLED` and `NEXT_PUBLIC_AMMORA_ENABLED` on
  Vercel and redeploy.

### `WALLET_DERIVATION_SECRET`

Every per-account agent wallet key is `keccak256(HMAC-SHA256(secret, "flizy:agent:v2:" + account id))`.
The secret is what stops an account id from being key material on its own.

Three rules:

1. **Same value everywhere.** The bot (`/opt/flizy/.env`) and the site (Vercel project env)
   must hold the identical string. Different values mean an account resolves to one address
   in chat and a different one on the site, and funds land where the other half cannot see them.
2. **Changing it changes every agent wallet address.** Treat a change as a migration, not a
   config edit. Sweep funds off the old addresses first with `scripts/sweep-agent-wallets.js`.
3. **Missing or under 32 characters is fatal on purpose.** Both processes refuse to start or
   derive rather than fall back to the old id-only derivation.

The derivation is implemented twice, in `lib/agentWallet.js` (bot) and `web/lib/agentWallet.ts`
(site), because the web bundle cannot import root `lib/`. `test/agentWallet.test.js` and
`test/webAgentWallet.test.js` pin the same vector on both sides, so drift fails the suite.
Do not edit one without the other.

---

## Engineering rules

These are enforced in code review and by tests:

- No secrets in any chat, log, or client bundle. That includes the Telegram bot token, and
  it includes the message body of an unlock exchange.
- User sends and swaps sign from the **agent wallet**, never the ops key, after link.
- Transfers reach approved destinations only, when enforcement is on.
- Swaps use allowlisted routers only, and the fee is disclosed before confirm.
- Claims match on **normalized phone**, never on a chat id alone. A Telegram user id is not
  a phone number.
- One phone maps to exactly one account, across every channel.
- Chat clients are adapters. A client never enforces a money rule; the policy layer does.
- Every money path goes plan, then explicit confirm, then receipt.

---

## Repository layout

| Path | Purpose |
|------|---------|
| `index.js` | WhatsApp client (adapter) |
| `telegram.js` | Telegram client entrypoint (adapter) |
| `lib/router.js` | Channel-agnostic command router: every command lives here once |
| `lib/telegram/` | Bot API client and update loop |
| `lib/notify.js` | Cross-channel notifications and outbox drain |
| `lib/gatorExecute.js` | Smart-account executor. Per-call gas (estimate + 20%, floor 500,000, ceiling 1,000,000), refuses on a failed estimate, records the tx hash before broadcast. Mirror: `web/lib/gatorExecute.ts` |
| `lib/reconcile.js` | Runs in the WhatsApp process every minute. Settles sends whose outcome was unknown (broadcast, no receipt) from their receipt: transfers, limit orders, claim holds. No receipt after an hour: flagged and admins notified, and still rechecked, so a late receipt still settles |
| `lib/priceSnapshots.js` | Runs in the WhatsApp process every 5 minutes. Writes one reserves snapshot per verified pool per 15 minute bucket to `token_price_snapshots` and deletes rows older than two days. The median of the newest four is the reference that lets swaps and liquidity changes skip the PIN (`lib/priceReference.js`). While the process is down the reference goes stale after 30 minutes and those trades ask for the PIN |
| `lib/runtime.js` | Shared chain, provider, ops and escrow wallets |
| `lib/` | Identity, claims, phone, engine, dex, chains, agent wallet, escrow |
| `lib/engine/` | Intent, Policy, Plan, Execute, Receipt |
| `web/` | Next.js site and swap API |
| `contracts/src/dex/` | WETH, FLZ, FlizyToken (IZY, MAKI), V2 factory/pair/router, fee router |
| `contracts/src/` | FlizyWallet and factory |
| `deployments/` | Live addresses and verification record (GIWA Sepolia) |
| `supabase/migrations/` | Schema, applied in timestamp order |
| `scripts/sql/` | Destructive one-off SQL, never applied in order, run by hand only |
| `docs/` | Operations, architecture, swap fees, trusted addresses |
| `deploy/` | systemd units (WhatsApp and Telegram) |
| `test/` | Node test suite |
| `.env.example` | Configuration template |

---

## Component status

| Area | State |
|------|--------|
| Site identity, dashboard, link codes | Live |
| WhatsApp client and agent sends | Live (GIWA Sepolia) |
| Telegram client on the same engine | Built and tested |
| Channel-agnostic identity (both chat apps on one account) | Built and tested |
| Approved destinations and daily limits (policy layer) | Live |
| Phone claims, escrow, cancel | Live |
| Payment requests | Live |
| Phone join key for LID-only WhatsApp sessions | Live |
| DEX, FLZ, IZY, MAKI, fee router | Live and verified on GIWA Sepolia |
| Site swap and liquidity add/remove (FLZ, IZY, MAKI, DCAT) | Live |
| Chat buy / sell / swap / price | Live |
| Smart wallet deploy | Contracts in repo, not required for current agent EOAs |
| Listed tokens | IZY and MAKI (verified) and DCAT, from `lib/listedTokens.js` |
| More EVM chains | Chain registry ready |

---

## Testing

```cmd
npm test
```

Runs the Node test suite (policy decisions, identity rules, phone normalization, session
lock, swap quoting, router parsing). Contracts:

```bash
cd contracts && forge test
```
