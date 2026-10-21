# Flizy bots — systemd (VPS)

Replaces `screen` so the bots restart on crash and reboot.

Two units, one codebase, one `.env`:

| Unit | Process | Why separate |
| --- | --- | --- |
| `flizy.service` | `node index.js` (WhatsApp) | Drives headless Chromium. The fragile half: session loss, QR relink, memory. |
| `flizy-telegram.service` | `node telegram.js` (Telegram) | Plain HTTPS long polling. Must stay up when Chromium dies. |

Both talk to the same database, the same engine and the same wallets. A Chromium
OOM must not take payments offline on both channels, which is the whole reason
they are separate units rather than one process.

## Git on the server

`/opt/flizy` pulls over SSH from `git@github.com:rudazy/flizy.git`. HTTPS login does not
work: GitHub rejects an account password, and a saved token on this host has already
been refused.

The key is the read-only deploy key named `contabo`. The private key stays at
`/root/.ssh/flizy_deploy`. Leave write access off. The clone pins the key, and that
setting is not committed:

```bash
git config core.sshCommand "ssh -i /root/.ssh/flizy_deploy -o IdentitiesOnly=yes"
git remote set-url origin git@github.com:rudazy/flizy.git
```

A new clone needs both lines again, plus the public key from
`/root/.ssh/flizy_deploy.pub` (the line that starts with `ssh-ed25519`) saved on the
repo as a deploy key. Do not copy the private key off the server.

## Install (Contabo / Ubuntu)

```bash
cd /opt/flizy
git pull
npm install --omit=dev

# Node path (if not /usr/bin/node)
which node
# If needed, edit deploy/flizy.service ExecStart=

sudo cp deploy/flizy.service /etc/systemd/system/flizy.service
sudo cp deploy/flizy-telegram.service /etc/systemd/system/flizy-telegram.service
sudo systemctl daemon-reload
sudo systemctl enable flizy flizy-telegram
sudo systemctl start flizy flizy-telegram
sudo systemctl status flizy --no-pager
sudo systemctl status flizy-telegram --no-pager
```

## Telegram

Needs `TELEGRAM_BOT_TOKEN` in `/opt/flizy/.env`. The process refuses to start
without it. Only one process may poll a token at a time: a second poller makes
Telegram return 409 and both stall, so never run `node telegram.js` by hand while
the unit is active.

Long polling needs no inbound port and no public URL. Switching to webhooks later
would need: a public HTTPS endpoint on this box (nginx + certbot), `setWebhook`
with a secret token, and verification of the `X-Telegram-Bot-Api-Secret-Token`
header on every request. Nothing else in the codebase changes.

## Stop old screen session first

```bash
screen -ls
# if flizy is running: screen -r flizy → Ctrl+C → exit
# or: pkill -f "node index.js"  (only if you are sure)
```

## Logs

```bash
journalctl -u flizy -f
journalctl -u flizy-telegram -f
```

## Restart after deploy

```bash
cd /opt/flizy && git pull && npm install --omit=dev
sudo systemctl restart flizy flizy-telegram
```

## Env

`/opt/flizy/.env` must exist (EnvironmentFile). Never commit secrets.
