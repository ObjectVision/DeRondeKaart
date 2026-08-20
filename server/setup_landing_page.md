# Setting up a landing page

Provisions one **Hugo** landing-page instance behind nginx, with automatic
redeploys on every push to a GitHub branch. Automated by
[`setup_landing_page.sh`](setup_landing_page.sh).

Any number of landing pages can run on the same host — each is identified by a
`--slug` and served on its own hostname. See [README.md](README.md) for the
shared multi-instance model.

---

## What it produces

| Path | Purpose |
|---|---|
| `/srv/<slug>` | cloned Hugo source repo |
| `/var/www/<slug>` | nginx webroot (built site) |
| `/etc/nginx/sites-available/<slug>` | nginx server block (symlinked into `sites-enabled/`) |
| `/usr/local/bin/deploy-<slug>.sh` | deploy script (pull → `hugo --minify` → webroot) |
| `/var/log/<slug>-deploy.log` | deploy log |
| hook `deploy-<slug>` in `/etc/webhook/hooks.json` | GitHub push trigger |

Shared, installed once: nginx, git, **Hugo extended**, the webhook daemon on
`127.0.0.1:9000`, and (unless `--no-tls`) a Let's Encrypt certificate.

---

## Parameters

Provide any of these as flags to skip the matching prompt; run with `-y` to accept
all defaults non-interactively.

| Flag | Prompt | Default |
|---|---|---|
| `--slug NAME` | Instance slug | *(required)* |
| `--host HOST` | Primary hostname | *(required)* |
| `--alias HOST` | Alias host that 301s to primary (repeatable) | *(none)* |
| `--repo URL` | Git remote of the Hugo source | *(required)* |
| `--branch NAME` | Git branch to deploy | `main` |
| `--hugo-version VER` | Hugo extended version | `0.161.1` |
| `--secret HEX` | GitHub webhook HMAC secret | *generated* |
| `--email ADDR` | Let's Encrypt email | *(required unless `--no-tls`)* |
| `--no-tls` | Serve plain HTTP, skip certbot | off |

---

## Process

1. **Base stack** — install nginx/git/jq/rsync; enable nginx.
2. **Hugo** — install the pinned Hugo *extended* binary to `/usr/local/bin/hugo`
   if that exact version is not already present.
3. **Directories** — create `/srv/<slug>` (owned by the deploy user) and
   `/var/www/<slug>` (owned `<user>:www-data`, mode 755).
4. **Clone + first build** — clone the repo, then
   `hugo --minify --baseURL https://<host>/ --destination /var/www/<slug>`.
5. **Deploy script** — write `/usr/local/bin/deploy-<slug>.sh` that fetches, hard-
   resets to `origin/<branch>`, and rebuilds. It logs to `/var/log/<slug>-deploy.log`.
   Builds coalesce (**run one, queue one, drop the rest**) via two `flock` locks
   under `/run`, so a burst of commits cannot pile up concurrent builds. The
   queued build re-runs `git reset --hard`, so it lands on the newest commit.
6. **Webhook** — ensure the shared webhook daemon exists, then **generate/register
   the HMAC secret** as hook id `deploy-<slug>` (leaving other instances' hooks
   untouched; the daemon is restarted so it re-reads `hooks.json`).
7. **nginx** — write and enable the server block: serves the webroot, proxies
   `/hooks/` to `127.0.0.1:9000`, `404 → /404.html`, gzip, security headers.
   Alias hosts get a 301 to the primary.
8. **TLS** — `certbot --nginx --redirect` for the primary host and any aliases,
   unless `--no-tls`.
9. **Output** — print the GitHub webhook settings, **including the secret**.

---

## After running: connect GitHub

On the source repo, **Settings → Webhooks → Add webhook**:

| Field | Value |
|---|---|
| Payload URL | `https://<host>/hooks/deploy-<slug>` |
| Content type | `application/json` |
| Secret | *the secret printed by the script* |
| Events | Just the push event |

Push to the tracked branch and watch `tail -f /var/log/<slug>-deploy.log`.

### Private repositories

If the repo is private, add a deploy key on the server before running:

```bash
ssh-keygen -t ed25519 -C "deploy@<host>" -f ~/.ssh/deploy_<slug> -N ""
cat ~/.ssh/deploy_<slug>.pub   # add as a read-only deploy key on GitHub
cat >> ~/.ssh/config <<EOF
Host github.com-<slug>
    HostName github.com
    IdentityFile ~/.ssh/deploy_<slug>
    IdentitiesOnly yes
EOF
```

then pass `--repo git@github.com-<slug>:ORG/REPO.git`.

---

## Examples

```bash
# Interactive
./setup_landing_page.sh

# Non-interactive, matching the current production instance
./setup_landing_page.sh -y \
  --slug woonzorglimburg_landing \
  --host woonzorglimburg.nl --alias www.woonzorglimburg.nl \
  --repo git@github.com:ObjectVision/woonzorglimburg_landing.git \
  --email eoudejans@objectvision.nl

# A second landing page on the same server
./setup_landing_page.sh -y \
  --slug acme_landing --host acme.example.com \
  --repo git@github.com:acme/site.git --email ops@acme.com
```
