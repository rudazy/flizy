# Flizy

WhatsApp-native crypto wallet and trading agent. Multichain EVM. Launches on GIWA.

Transfers only go to trusted destinations managed on the site. Session keys cannot drain to strangers when the smart wallet is deployed.

## Layout

| Path | Purpose |
|------|---------|
| `index.js` | WhatsApp bot |
| `lib/` | Shared chain registry, identity, session, trusted, DEX, transfer log |
| `web/` | Next.js site (signup, dashboard, docs, claim links) |
| `contracts/` | Foundry smart wallet + CREATE2 factory |
| `supabase/migrations/` | Schema |

## Hard rules

- No secrets in WhatsApp or plaintext logs
- Commands use the `flizy` prefix
- Trusted addresses: site only
- Palette: lime `#c8f135`, gold `#f5c842`, base `#0a0a0a`

## Setup (Windows CMD)

```cmd
cd C:\Users\Ludarep\flizy
copy .env.example .env
REM fill SUPABASE_*, PRIVATE_KEY, BOT_WHATSAPP_NUMBER

npx.cmd supabase db push
npm.cmd install
cd web
npm.cmd install
cd ..
```

## Run bot

```cmd
cd C:\Users\Ludarep\flizy
node index.js
```

WhatsApp examples:

```text
flizy help
flizy unlock 1234
flizy link ABC123
flizy send 0.001 to ama
flizy confirm
```

## Run site

```cmd
cd C:\Users\Ludarep\flizy\web
npm.cmd run dev
```

Open http://localhost:3000

## Contracts (Foundry)

```cmd
cd C:\Users\Ludarep\flizy\contracts
forge install foundry-rs/forge-std
forge test
```

## Env flags

| Flag | Default | Meaning |
|------|---------|---------|
| `REQUIRE_FLIZY_PREFIX` | true | Commands must start with `flizy` |
| `ENFORCE_TRUSTED` | true | Sends must hit site trusted list |
| `REQUIRE_UNLOCK` | true | PIN session for sensitive actions |
| `REJECT_UNTRUSTED_COPY` | (string) | Short reject message |
| `DEFAULT_CHAIN` | giwa_sepolia | Chain registry key |

## Phases

0 Registry and config: done  
1 Site identity + WA link: done  
2 Smart wallet + session keys: contracts in repo  
3 Allowlist site + bot enforce: done (on-chain via wallet)  
4 Prefix + unlock: done  
5 DEX helpers: `lib/dex.js` (needs router env)  
6 Claims: schema + claim page  
7 Multichain: registry ready  
8 Hosting: `vercel.json` for site; bot needs always-on host  
