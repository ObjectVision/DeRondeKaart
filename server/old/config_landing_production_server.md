# Roadmap to Production — Wonen en zorganalyse Limburg

This document guides you from a fresh Debian/Ubuntu server to a fully running production deployment of the Hugo landing page. Follow every section in order.

**The site will be reachable at: `http://37.97.169.242`**

---

## 1. Prerequisites

Before starting, have the following ready:

- SSH access to `cicada@37.97.169.242`
- Server running Debian 11+ or Ubuntu 22.04+
- GitHub repository: `git@github.com:ObjectVision/woonzorglimburg_landing.git`
- A GitHub deploy key or the repo set to public (required for `git clone` on the server)
- A webhook secret — generate one now on your local machine:
  ```bash
  openssl rand -hex 32
  ```
  Save this value; you will need it in Sections 5 and 7.

---

## 2. Server Setup — Hugo and nginx

Connect to the server:

```bash
ssh cicada@37.97.169.242
```

### 2.1 Update packages

```bash
sudo apt-get update && sudo apt-get upgrade -y
```

### 2.2 Install nginx and git

```bash
sudo apt-get install -y nginx git curl
sudo systemctl enable nginx
sudo systemctl start nginx
```

### 2.3 Install Hugo Extended (>= 0.110.0)

The apt package is outdated. Install the official extended binary directly:

```bash
HUGO_VERSION="0.147.1"
curl -L "https://github.com/gohugoio/hugo/releases/download/v${HUGO_VERSION}/hugo_extended_${HUGO_VERSION}_linux-amd64.tar.gz" \
  -o /tmp/hugo.tar.gz
tar -xzf /tmp/hugo.tar.gz -C /tmp
sudo mv /tmp/hugo /usr/local/bin/hugo
sudo chmod +x /usr/local/bin/hugo
rm /tmp/hugo.tar.gz
hugo version
```

> For ARM64 servers, replace `linux-amd64` with `linux-arm64` in the URL.

---

## 3. Clone the Repository and First Build

### 3.1 Add a deploy key (if the repo is private)

On the server, generate an SSH key:

```bash
ssh-keygen -t ed25519 -C "deploy@37.97.169.242" -f ~/.ssh/deploy_key -N ""
cat ~/.ssh/deploy_key.pub
```

Copy the output and add it as a read-only deploy key at:
`https://github.com/ObjectVision/woonzorglimburg_landing/settings/keys/new`

Then configure SSH to use this key for GitHub:

```bash
cat >> ~/.ssh/config <<'EOF'
Host github.com
    IdentityFile ~/.ssh/deploy_key
    IdentitiesOnly yes
EOF
```

### 3.2 Clone the repository

```bash
sudo mkdir -p /srv/woonzorglimburg
sudo chown cicada:cicada /srv/woonzorglimburg
git clone git@github.com:ObjectVision/woonzorglimburg_landing.git /srv/woonzorglimburg
```

### 3.3 Create the nginx webroot

```bash
sudo mkdir -p /var/www/woonzorglimburg
sudo chown cicada:www-data /var/www/woonzorglimburg
sudo chmod 755 /var/www/woonzorglimburg
```

### 3.4 First build

```bash
cd /srv/woonzorglimburg
hugo --minify --baseURL "http://37.97.169.242/" --destination /var/www/woonzorglimburg
ls /var/www/woonzorglimburg
```

You should see `index.html`, `404.html`, `robots.txt`, `sitemap.xml`, and asset directories.

---

## 4. nginx Configuration

### 4.1 Write the server block

Create `/etc/nginx/sites-available/woonzorglimburg`:

```nginx
server {
    listen 80;
    server_name 37.97.169.242;

    root /var/www/woonzorglimburg;
    index index.html;

    location / {
        try_files $uri $uri/ =404;
    }

    # Proxy webhook requests to the internal listener on localhost:9000
    location /hooks/ {
        proxy_pass http://127.0.0.1:9000/hooks/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 30s;
    }

    error_page 404 /404.html;
    location = /404.html {
        internal;
    }

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN";
    add_header X-Content-Type-Options "nosniff";
    add_header Referrer-Policy "strict-origin-when-cross-origin";

    # Gzip compression
    gzip on;
    gzip_types text/plain text/css application/javascript image/svg+xml;
    gzip_min_length 1024;
}
```

### 4.2 Enable and reload

```bash
sudo ln -s /etc/nginx/sites-available/woonzorglimburg_landing /etc/nginx/sites-enabled/woonzorglimburg_landing
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

At this point `http://37.97.169.242` serves the landing page.

---

## 5. Webhook Setup — adnanh/webhook

The `adnanh/webhook` binary listens on `localhost:9000`. nginx proxies
`http://37.97.169.242/hooks/deploy` to it, keeping port 9000 internal.

### 5.1 Install the webhook binary

```bash
WEBHOOK_VERSION="2.8.1"
curl -L "https://github.com/adnanh/webhook/releases/download/${WEBHOOK_VERSION}/webhook-linux-amd64.tar.gz" \
  -o /tmp/webhook.tar.gz
tar -xzf /tmp/webhook.tar.gz -C /tmp
sudo mv /tmp/webhook-linux-amd64/webhook /usr/local/bin/webhook
sudo chmod +x /usr/local/bin/webhook
rm -rf /tmp/webhook.tar.gz /tmp/webhook-linux-amd64
webhook --version
```

### 5.2 Create the hooks configuration

```bash
sudo mkdir -p /etc/webhook
sudo chown cicada:cicada /etc/webhook
```

Create `/etc/webhook/hooks.json` — replace `YOUR_WEBHOOK_SECRET_HERE` with your secret from Section 1:

```json
[
  {
    "id": "deploy",
    "execute-command": "/usr/local/bin/deploy-woonzorglimburg_landing.sh",
    "command-working-directory": "/srv/woonzorglimburg_landing",
    "response-message": "Deployment triggered.",
    "trigger-rule": {
      "and": [
        {
          "match": {
            "type": "payload-hmac-sha256",
            "secret": "YOUR_WEBHOOK_SECRET_HERE",
            "parameter": {
              "source": "header",
              "name": "X-Hub-Signature-256"
            }
          }
        },
        {
          "match": {
            "type": "value",
            "value": "refs/heads/main",
            "parameter": {
              "source": "payload",
              "name": "ref"
            }
          }
        }
      ]
    }
  }
]
```

The two rules enforce: (1) valid HMAC-SHA256 signature from GitHub, (2) push is to the `main` branch.

### 5.3 Create the systemd service

Create `/etc/systemd/system/webhook.service`:

```ini
[Unit]
Description=adnanh webhook listener — woonzorglimburg deployments
After=network.target

[Service]
Type=simple
User=cicada
Group=cicada
ExecStart=/usr/local/bin/webhook \
    -hooks /etc/webhook/hooks.json \
    -ip 127.0.0.1 \
    -port 9000 \
    -verbose
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable webhook
sudo systemctl start webhook
sudo systemctl status webhook
ss -tlnp | grep 9000
```

---

## 6. Deploy Script

Create `/usr/local/bin/deploy-woonzorglimburg.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="/srv/woonzorglimburg_landing"
WEBROOT="/var/www/woonzorglimburg_landing"
BASE_URL="http://37.97.169.242/"
LOG="/var/log/woonzorglimburg_landing-deploy.log"

exec >> "$LOG" 2>&1
echo "--- Deploy started: $(date --iso-8601=seconds) ---"

cd "$REPO_DIR"

echo "Pulling latest code from main..."
git fetch --prune origin
git reset --hard origin/main

echo "Building Hugo site..."
hugo --minify --baseURL "$BASE_URL" --destination "$WEBROOT"

echo "--- Deploy finished: $(date --iso-8601=seconds) ---"
```

Make it executable and create the log file:

```bash
sudo chmod +x /usr/local/bin/deploy-woonzorglimburg_landing.sh
sudo touch /var/log/woonzorglimburg_landing-deploy.log
sudo chown cicada:cicada /var/log/woonzorglimburg_landing-deploy.log
```

Test it manually:

```bash
/usr/local/bin/deploy-woonzorglimburg_landing.sh
tail /var/log/woonzorglimburg_landing-deploy.log
```

---

## 7. GitHub Webhook Configuration

In your browser, go to:

```
https://github.com/ObjectVision/woonzorglimburg_landing/settings/hooks/new
```

| Field | Value |
|---|---|
| Payload URL | `http://37.97.169.242/hooks/deploy` |
| Content type | `application/json` |
| Secret | your webhook secret from Section 1 |
| Which events? | **Just the push event** |
| Active | checked |

Click **Add webhook**. GitHub sends a `ping` event — it should show a green checkmark. The ping does not trigger a deploy (no matching `ref`), which is correct.

---

## 8. Verification

```bash
# Site responds
curl -I http://37.97.169.242/

# Webhook endpoint is proxied (400 = no valid signature = correct)
curl -s -o /dev/null -w "%{http_code}" http://37.97.169.242/hooks/deploy

# Services are running
sudo systemctl status nginx
sudo systemctl status webhook
```

**End-to-end test:** push a trivial change to `main` and watch:

```bash
# On server
tail -f /var/log/woonzorglimburg_landing-deploy.log
```

Within seconds you should see the deploy cycle complete. In GitHub under
`Settings > Webhooks > Recent Deliveries` the delivery should show HTTP 200.

---

## 9. Access

**The landing page is served at:**

```
http://37.97.169.242
```

Every push to `main` automatically:
1. Pulls the latest code to `/srv/woonzorglimburg_landing`
2. Rebuilds with Hugo extended (`--minify --baseURL "http://37.97.169.242/"`)
3. Writes output to `/var/www/woonzorglimburg_landing`
4. Makes the updated site live immediately (nginx serves static files; no restart needed)

---

## File Locations Summary

| Purpose | Path |
|---|---|
| Hugo source (cloned repo) | `/srv/woonzorglimburg_landing` |
| nginx webroot (Hugo output) | `/var/www/woonzorglimburg_landing` |
| nginx site config | `/etc/nginx/sites-available/woonzorglimburg_landing` |
| Webhook hooks config | `/etc/webhook/hooks.json` |
| Webhook systemd unit | `/etc/systemd/system/webhook.service` |
| Deploy script | `/usr/local/bin/deploy-woonzorglimburg_landing.sh` |
| Deploy log | `/var/log/woonzorglimburg_landing-deploy.log` |
| Hugo binary | `/usr/local/bin/hugo` |
| Webhook binary | `/usr/local/bin/webhook` |
