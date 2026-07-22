# Flizy bot — systemd (VPS)

Replaces `screen` so the bot restarts on crash and reboot.

## Install (Contabo / Ubuntu)

```bash
cd /opt/flizy
git pull
npm install --omit=dev

# Node path (if not /usr/bin/node)
which node
# If needed, edit deploy/flizy.service ExecStart=

sudo cp deploy/flizy.service /etc/systemd/system/flizy.service
sudo systemctl daemon-reload
sudo systemctl enable flizy
sudo systemctl start flizy
sudo systemctl status flizy
```

## Stop old screen session first

```bash
screen -ls
# if flizy is running: screen -r flizy → Ctrl+C → exit
# or: pkill -f "node index.js"  (only if you are sure)
```

## Logs

```bash
journalctl -u flizy -f
```

## Restart after deploy

```bash
cd /opt/flizy && git pull && npm install --omit=dev
sudo systemctl restart flizy
```

## Env

`/opt/flizy/.env` must exist (EnvironmentFile). Never commit secrets.
