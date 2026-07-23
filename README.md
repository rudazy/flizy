<p align="center">
  <img src="web/public/logo.svg" alt="Flizy" width="280" />
</p>

<h1 align="center">Flizy</h1>

<p align="center">
  <strong>WhatsApp-native EVM wallet and swap.</strong><br />
  Trusted destinations only. GIWA-first. Built to expand across EVM.
</p>

<p align="center">
  <a href="https://flizy.vercel.app">Live site</a>
  ·
  <a href="https://flizy.vercel.app/how-it-works">How it works</a>
  ·
  <a href="https://flizy.vercel.app/docs">Security docs</a>
  ·
  <a href="docs/swap-fees.md">Swap fees</a>
</p>

---

## What Flizy is

Flizy lets people **send and swap crypto from WhatsApp** (and the site) without pasting seed phrases into chat. Each user has a permanent **agent wallet** tied to their site account. Transfers move only to **trusted destinations** they approve. Swaps go only through **allowlisted DEX routers**. Phone claims hold funds in escrow until the recipient links WhatsApp. The product launches on **GIWA Sepolia** and is designed so additional EVM chains and tokens can be added through config, not a rewrite.

| Layer | Role |
|--------|------|
| **Web site** | Signup, dashboard, trusted list, PIN, link codes, claim pages, **Swap + liquidity** |
| **WhatsApp bot** | Commands (`flizy …`), plan/confirm, claims, requests, swaps from agent wallet |
| **Supabase** | Accounts, WhatsApp identities (+ phone join key), trusted, transfers, claims, requests |
| **DEX contracts** | Uniswap V2-style factory/router, fee router, WETH, FLZ token, FLZ/WETH pair (GIWA Sepolia) |
| **Wallet contracts** | `FlizyWallet` + CREATE2 factory in repo (next custody phase; not required for current agent EOA) |
| **Ops wallet** | Gas / infra + protocol fee treasury (`PRIVATE_KEY`); not the user’s send address |
| **Escrow wallet** | Holds pending phone claims until claim or cancel |

---

## Deployed contracts (GIWA Sepolia)

**Network:** GIWA Sepolia · **Chain ID:** `91342`  
**Explorer base:** [https://sepolia-explorer.giwa.io](https://sepolia-explorer.giwa.io)  
**Full JSON:** [`deployments/giwa-sepolia.json`](deployments/giwa-sepolia.json)

| Contract | Address | Explorer |
|----------|---------|----------|
| **WETH9** | `0x3a13399f2741122B63c7710B2A85346B97C6BFDf` | [View](https://sepolia-explorer.giwa.io/address/0x3a13399f2741122B63c7710B2A85346B97C6BFDf) |
| **FLZ** (Flizy test token, 100k supply, 18 decimals) | `0x308be8f71DA695f18E70D2243a446e1fD1566BA6` | [View](https://sepolia-explorer.giwa.io/address/0x308be8f71DA695f18E70D2243a446e1fD1566BA6) |
| **UniswapV2Factory** | `0xBB1d2c582E455B448660A199097A54DF29162BbF` | [View](https://sepolia-explorer.giwa.io/address/0xBB1d2c582E455B448660A199097A54DF29162BbF) |
| **UniswapV2Router02** | `0x4055413A4757e069bbCAc481639EF2814224Faa0` | [View](https://sepolia-explorer.giwa.io/address/0x4055413A4757e069bbCAc481639EF2814224Faa0) |
| **FlizyFeeRouter** (protocol fee, default 30 bps, max 100 bps) | `0x6427fD0c13577847888B7E2d1A24C887bBEBd9cC` | [View](https://sepolia-explorer.giwa.io/address/0x6427fD0c13577847888B7E2d1A24C887bBEBd9cC) |
| **FLZ / WETH pair** | `0xEC6Ebf4A7a3088EB22535C9F767B9Ab5845D8227` | [View](https://sepolia-explorer.giwa.io/address/0xEC6Ebf4A7a3088EB22535C9F767B9Ab5845D8227) |

**Treasury / fee destination (ops):** `0x81Fb7Ed21B9843D2D5C232A7F3e959F91993401B`  
[View treasury](https://sepolia-explorer.giwa.io/address/0x81Fb7Ed21B9843D2D5C232A7F3e959F91993401B)

**Seed liquidity (testnet):** 1.2 ETH + 60,000 FLZ (starting ~50,000 FLZ per 1 ETH).  
**Source:** `contracts/src/dex/*` · deploy script `contracts/script/DeployDex.s.sol`

### Contracts in repo (not required on-chain for current bot)

| Contract | Path | Status |
|----------|------|--------|
| FlizyWallet | `contracts/src/FlizyWallet.sol` | Foundry tests; deploy when session-key custody ships |
| FlizyWalletFactory | `contracts/src/FlizyWalletFactory.sol` | CREATE2 factory for future smart wallets |

---

## Product architecture

```mermaid
flowchart TB
  subgraph Clients
    U[User phone]
    S[flizy.vercel.app]
  end

  subgraph Flizy
    W[WhatsApp bot<br/>index.js]
    DB[(Supabase)]
    POL[Policy engine<br/>trusted · limits · routers]
    ENG[Intent → Plan → Confirm → Execute → Receipt]
    AW[Agent wallet<br/>per account]
  end

  subgraph OnChain["GIWA Sepolia"]
    ESC[Claim escrow wallet]
    FEE[FlizyFeeRouter]
    V2[V2 Router + Factory]
    PAIR[FLZ/WETH pair]
    FLZ[FLZ token]
    WETH[WETH9]
  end

  U -->|signup · trusted · PIN · link code · swap UI| S
  S --> DB
  U -->|flizy link · send · claim · swap| W
  W --> DB
  W --> ENG
  ENG --> POL
  POL -->|transfer OK| AW
  POL -->|swap router allowlist| AW
  AW -->|native transfer| OnChain
  AW -->|swap / add LP| FEE
  FEE --> V2
  V2 --> PAIR
  PAIR --- FLZ
  PAIR --- WETH
  AW -->|claim hold| ESC
  ESC -->|claim payout / cancel refund| AW
```

### Component map

```text
                    +------------------------+
                    |   flizy.vercel.app     |
                    |  dashboard · swap UI   |
                    |  liquidity add/remove  |
                    +-----------+------------+
                                |
                                v
                    +------------------------+
                    |       Supabase         |
                    | accounts · WA + phone  |
                    | trusted · claims · txs |
                    +-----------+------------+
                                ^
                                |
  +----------+         +--------+--------+         +------------------+
  | User WA  | ------> |  Flizy bot       | -----> | Agent wallets    |
  | phones   |         |  Policy + Plan   | sign   | (per account)    |
  +----------+         +--------+--------+         +--------+---------+
                                |                           |
                     ops / treasury / escrow                v
                                                    GIWA Sepolia DEX
                                                    FeeRouter → V2 → Pair
```

---

## End-to-end flows

### 1. Account link and trusted send

```mermaid
sequenceDiagram
  participant U as User
  participant Site as Site
  participant Bot as WhatsApp bot
  participant Chain as GIWA Sepolia

  U->>Site: Signup · agent wallet derived
  U->>Site: Add trusted name · generate link code
  U->>Bot: flizy link CODE
  Note over Bot: Stores LID as identity<br/>captures phone for claims join
  Bot->>Site: Bind WA to account
  U->>Bot: flizy send 0.001 to john
  Bot->>Bot: Intent → Policy trusted + limits → Plan
  Bot-->>U: Transfer plan
  U->>Bot: confirm
  Bot->>Chain: Sign from agent wallet
  Bot-->>U: Receipt + explorer link
```

### 2. Phone claim (escrow)

```mermaid
sequenceDiagram
  participant S as Sender
  participant Bot as WhatsApp bot
  participant Esc as Claim escrow
  participant R as Recipient

  S->>Bot: flizy send 0.01 to 234…
  Bot->>Bot: CLAIM_HOLD plan · confirm
  Bot->>Esc: Hold ETH from sender agent wallet
  Note over Bot: Claim row to_wa_hint = phone digits
  R->>Site: Signup · flizy link CODE
  Note over Bot: Phone stored on identity next to LID
  R->>Bot: flizy claim
  Bot->>Bot: Match claim by phone not LID
  Bot->>Esc: Payout to recipient agent wallet
  Bot-->>R: Receipt
  Note over S: flizy cancel claims anytime while pending
```

### 3. Swap (WhatsApp or site)

```mermaid
sequenceDiagram
  participant U as User
  participant Client as Bot or Site
  participant Pol as Policy
  participant Fee as FeeRouter
  participant Pair as FLZ/WETH pair

  U->>Client: buy / sell / swap amount
  Client->>Pol: Swap intent router allowlist<br/>no trusted-contacts · no daily send limit
  Pol-->>Client: ALLOW_WITH_CONFIRM
  Client-->>U: Plan shows amount out · fee % · fee amount · slippage · chain
  U->>Client: confirm / Confirm swap
  Client->>Fee: swap via agent wallet
  Fee->>Fee: Take protocol fee to treasury
  Fee->>Pair: V2 swap remainder
  Client-->>U: Receipt + explorer after confirmation
```

### 4. Liquidity (site only)

```mermaid
flowchart LR
  A[Site Swap · + Liquidity] --> B{Add or Remove}
  B -->|Add| C[Approve FLZ · FeeRouter.addLiquidityETH]
  B -->|Remove| D[Approve FLZ-LP · V2 removeLiquidityETH]
  C --> E[LP tokens on agent wallet]
  D --> F[ETH + FLZ back to agent wallet]
```

---

## What Flizy does today

### Identity and accounts

- Email signup / login; strong password policy.
- Permanent account; agent wallet derived once (`flizy:agent:v1:{accountId}`), not rotated.
- WhatsApp link codes; `flizy link CODE` binds observed sender id (**LID-first** identity).
- **Phone join key** on `whatsapp_identities.wa_phone_e164` for claims/requests (normalized digits). LID stays identity; phone is only the claim address match.

### Agent wallet

- Dashboard and WhatsApp show the same address after link.
- User funds the agent wallet; sends and swaps sign from that wallet (not ops).

### Trusted destinations

- Site and `flizy add wallet` manage allowlist.
- When `ENFORCE_TRUSTED=true`, transfers outside the list are denied by **Policy** (not the client UI alone).

### Claims and payment requests

- Send to a phone → escrow hold → recipient `flizy claim` after link.
- `flizy cancel claims` anytime while pending.
- `flizy request` / `flizy pay` use the same phone join key as claims.

### Swap and FLZ

- Site: Uniswap-style UI (pay / flip / receive), fee disclosure, **+ Liquidity** (add and remove).
- WhatsApp: `flizy buy`, `sell`, `swap`, `price` with plan → confirm → receipt.
- Protocol fee default **0.30%** (30 bps), hard max **1%**, paid to treasury; plus V2 pool fee. Details: [`docs/swap-fees.md`](docs/swap-fees.md).
- Swaps do **not** use trusted-contacts checks and do **not** count against daily send limit.

### WhatsApp commands

All product commands use the **`flizy` prefix** (configurable). Bare `confirm` / `cancel` for pending plans.

| Command | Purpose |
|---------|---------|
| `flizy help` | Command list |
| `flizy link CODE` | Bind WhatsApp to site account |
| `flizy me` / `balance` / `deposit` / `history` | Account and wallet |
| `flizy add wallet 0x…` | Trusted destination flow |
| `flizy send AMOUNT to name\|0x\|phone` | Transfer or phone claim hold |
| `flizy claim` / `flizy cancel claims` | Receive or cancel phone claims |
| `flizy request` / `pay` / `requests` | Payment requests |
| `flizy buy AMOUNT FLZ` | Spend ETH for FLZ |
| `flizy sell AMOUNT FLZ` | Sell FLZ for ETH |
| `flizy swap AMOUNT ETH for FLZ` | Explicit pair swap |
| `flizy price FLZ` | Pool spot price |
| `confirm` / `cancel` | Execute or drop pending plan |
| `flizy unlock PIN` / `lock` | Session when PIN is set |

### Web site surfaces

| Route | Purpose |
|-------|---------|
| `/` | Product home |
| `/how-it-works` · `/docs` | Guides |
| `/signup` · `/login` | Auth |
| `/dashboard` | Home, wallet, history, account, link code |
| `/dashboard/swap` | Swap UI + liquidity add/remove |
| `/claim/[token]` | Public claim status page |

### Security model

- No private keys or seeds in WhatsApp.
- Agent keys server-side (testnet custody); ops and escrow keys separate.
- Policy-only money rules (trusted, limits, router allowlist).
- Optional unlock PIN; secrets only in env (bot host + Vercel).

### Infrastructure

- **Site:** Next.js (`web/`) on Vercel.
- **Bot:** Node + `whatsapp-web.js`; systemd on VPS recommended (`deploy/flizy.service`).
- **Data:** `supabase/migrations/`.
- **Contracts:** Foundry under `contracts/` (DEX live; smart wallet next).

---

## Multichain and multi-token roadmap

Flizy is **GIWA-first** (`lib/chains.js`, default `giwa_sepolia` / `91342`).

| Status | Scope |
|--------|--------|
| **Live** | GIWA Sepolia: agent sends, claims, requests, FLZ swap + LP |
| **In repo** | Chain registry + DEX addresses (env or `deployments/*.json`) |
| **Next tokens** | Token + pair registry (symbol → address → pair); UI picker; not a new AMM |
| **More EVM** | Register RPC, explorer, fee router, tokens; same Policy/Plan path |

---

## Repository layout

| Path | Purpose |
|------|---------|
| `index.js` | WhatsApp bot |
| `lib/` | Identity, claims, phone, engine, dex, chains, agent wallet, escrow |
| `lib/engine/` | Intent · Policy · Plan · Execute · Receipt |
| `web/` | Next.js site + swap API |
| `contracts/src/dex/` | WETH, FLZ, V2 factory/pair/router, fee router |
| `contracts/src/` | FlizyWallet + factory |
| `deployments/` | Live addresses (GIWA Sepolia) |
| `supabase/migrations/` | Schema |
| `docs/` | Swap fees, trusted addresses |
| `deploy/` | systemd unit |
| `.env.example` | Bot env template |

---

## Setup

### Prerequisites

- Node.js **18+** (22+ recommended)
- Supabase project
- WhatsApp for the bot number (linked device)
- Foundry optional (contracts)

### Bot (local or VPS)

```bash
cd /path/to/flizy
cp .env.example .env
# fill SUPABASE_*, GIWA_RPC, PRIVATE_KEY, BOT_WHATSAPP_NUMBER, SITE_URL
npm install
node index.js
```

VPS with systemd:

```bash
cd /opt/flizy && git pull && npm install --omit=dev
sudo systemctl restart flizy
journalctl -u flizy -f
```

Do not run the same WhatsApp session on Windows and VPS at once.

### Site

```bash
cd web
npm install
npm run dev
```

Production: deploy `web/` to Vercel.

### Database

```bash
npx supabase db push
```

Or apply SQL from `supabase/migrations/`.

### Contracts

```bash
cd contracts
forge install foundry-rs/forge-std
forge test
# redeploy DEX only if needed:
# node ../scripts/deploy-dex.js
```

---

## Environment (bot)

| Variable | Purpose |
|----------|---------|
| `SUPABASE_URL` / `SUPABASE_KEY` | Database (service role on bot) |
| `GIWA_RPC` | GIWA Sepolia RPC |
| `PRIVATE_KEY` | Ops / treasury hot wallet |
| `ESCROW_PRIVATE_KEY` | Optional dedicated claim escrow |
| `BOT_WHATSAPP_NUMBER` | Digits for `wa.me` deep links |
| `SITE_URL` | Public site URL |
| `ENFORCE_TRUSTED` | Trusted-list on transfers |
| `SWAP_FEE_BPS` / `SWAP_SLIPPAGE_BPS` | Defaults for display and quotes |
| `CHAIN_GIWA_SEPOLIA_*` | Optional overrides for WETH, routers, FLZ, pair |
| `FLIZY_TREASURY` | Fee destination (defaults to ops) |

See `.env.example`. Never commit real `.env` files.

---

## Hard rules

- No secrets in WhatsApp, logs, or client bundles.
- User sends and swaps use the **agent wallet**, not the ops key, after link.
- Transfers: trusted destinations when enforcement is on.
- Swaps: allowlisted routers only; fee disclosed before confirm.
- Claims match on **normalized phone**, not LID alone.
- Commands use the `flizy` prefix in production configuration.

---

## Status

| Area | State |
|------|--------|
| Site identity + dashboard + link codes | Live |
| WhatsApp multi-user bot + agent sends | Live (GIWA Sepolia) |
| Trusted list + daily limits (Policy) | Live |
| Phone claims + escrow + cancel | Live |
| Payment requests | Live |
| Phone join key for LID sessions | Live |
| DEX + FLZ + fee router | **Live** on GIWA Sepolia |
| Site swap + add/remove liquidity | Live |
| WhatsApp buy / sell / swap / price | Live |
| Smart wallet deploy | Contracts in repo; not required for current EOAs |
| More tokens / more EVM | Registry-ready; FLZ is first listed asset |

---

## License and contact

Private product repository. Site: [https://flizy.vercel.app](https://flizy.vercel.app).

Operators: supervise the bot process, rotate compromised keys immediately, and treat `PRIVATE_KEY`, escrow keys, and Supabase service keys as production secrets.
