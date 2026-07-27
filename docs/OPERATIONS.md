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
# fill SUPABASE_*, GIWA_RPC, PRIVATE_KEY, BOT_WHATSAPP_NUMBER, SITE_URL
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

```bash
npx supabase db push
```

Or apply SQL directly from `supabase/migrations/`. To run a single migration file against
the remote database:

```cmd
node scripts\run-migration-file.js supabase\migrations\FILE.sql
```

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
| `PRIVATE_KEY` | Ops / treasury hot wallet |
| `ESCROW_PRIVATE_KEY` | Optional dedicated claim escrow key |
| `BOT_WHATSAPP_NUMBER` | Digits for `wa.me` deep links |
| `TELEGRAM_BOT_TOKEN` | Telegram client. Never commit it, never log it |
| `TELEGRAM_BOT_USERNAME` | Bot username, no `@`, for `t.me/…?start=CODE` links. Also set on Vercel |
| `TELEGRAM_POLL_TIMEOUT_SEC` | Long poll wait, default 30 |
| `OUTBOX_DRAIN_MS` | Notification outbox poll, default 5000. Worst case delay for a cross-channel notice |
| `SITE_URL` | Public site URL |
| `ADMIN_PHONES` / `ADMIN_SETUP_SECRET` | Admin bootstrap |
| `ENFORCE_TRUSTED` | Approved-destination enforcement on transfers |
| `ENFORCE_CREDIT` | Require internal credit before a send |
| `REQUIRE_UNLOCK` | Require an unlocked session for sensitive actions |
| `REQUIRE_FLIZY_PREFIX` | Require the `flizy` prefix on WhatsApp |
| `MAX_SEND_ETH` / `DEFAULT_DAILY_SEND_LIMIT_ETH` | Per-transaction and per-day caps |
| `PENDING_TTL_MS` / `SESSION_TTL_MS` / `LINK_CODE_TTL_MS` | Plan, session and link code lifetimes |
| `SWAP_FEE_BPS` / `SWAP_SLIPPAGE_BPS` | Defaults for display and quotes |
| `CHAIN_GIWA_SEPOLIA_*` | Optional overrides for WETH, routers, FLZ, pair |
| `FLIZY_TREASURY` | Fee destination (defaults to ops) |
| `GAS_BUFFER_ETH` | Reserve kept for gas when checking funding |

Treat `PRIVATE_KEY`, escrow keys and Supabase service keys as production secrets. Rotate
immediately if one is exposed.

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
| `lib/runtime.js` | Shared chain, provider, ops and escrow wallets |
| `lib/` | Identity, claims, phone, engine, dex, chains, agent wallet, escrow |
| `lib/engine/` | Intent, Policy, Plan, Execute, Receipt |
| `web/` | Next.js site and swap API |
| `contracts/src/dex/` | WETH, FLZ, V2 factory/pair/router, fee router |
| `contracts/src/` | FlizyWallet and factory |
| `deployments/` | Live addresses and verification record (GIWA Sepolia) |
| `supabase/migrations/` | Schema |
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
| DEX, FLZ, fee router | Live and verified on GIWA Sepolia |
| Site swap and liquidity add/remove | Live |
| Chat buy / sell / swap / price | Live |
| Smart wallet deploy | Contracts in repo, not required for current agent EOAs |
| More tokens and more EVM chains | Registry ready, FLZ is the first listed asset |

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
