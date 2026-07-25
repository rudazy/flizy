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
