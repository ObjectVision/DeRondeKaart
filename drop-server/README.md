# drop-server

An **end-to-end-encrypted, upload-only** service ("secure drop") for receiving
sensitive files. Browsers seal files to an admin-held public key *before*
upload; the server stores opaque ciphertext it cannot decrypt; the private key
never touches the server or this repository. Retrieval is out-of-band: the
administrator copies the blobs off the server and decrypts them locally.

```
sender's browser                    server (VM)                admin machine
────────────────                    ───────────                ─────────────
file ──seal──> ciphertext ──POST──> /var/lib/<slug>/drops/ ──scp──> decrypt
      (public key,                  (ciphertext + sidecar,          (private key,
       crypto_box_seal)              nothing readable)               drop_decrypt.py)
```

There is **no read-back**: the HTTP surface has no route that returns a stored
drop. A compromise of the server or its disk discloses nothing without the
admin's private key.

## Components

| piece | what |
|---|---|
| `src/` | zero-dependency `node:http` service: `POST /drop`, `GET /drop/pubkey`, `GET /drop/healthz`, bound to 127.0.0.1 behind nginx; plus `cli.ts`, the open/close switch |
| `page/` | standalone Dutch upload page served at the site root (`https://aanleveren.woonzorglimburg.nl/`); seals with a locally vendored `libsodium-wrappers` — no CDN |
| `tools/` | admin-side Python (PyNaCl, PEP 723 — run with `uv run`): `drop_keygen.py`, `drop_encrypt.py`, `drop_decrypt.py` |
| `test/` | `node:test` suite (`npm test`): guards, HTTP integration, crypto round trip |
| [server/setup_drop_server.sh](../server/setup_drop_server.sh) | provisioning: hardened systemd unit + own nginx site + certbot + webhook auto-deploy |

Cryptography: NaCl **sealed boxes** (X25519 + XSalsa20-Poly1305,
`crypto_box_seal`). PyNaCl and `libsodium-wrappers` bind the same libsodium C
library, so blobs sealed by the browser page, `drop_encrypt.py`, or the test
suite are one wire format: 48 bytes overhead (ephemeral public key + MAC) +
ciphertext. Sealed boxes are authenticated: a tampered blob *fails to open*
rather than yielding garbage.

## Lifecycle

### 1. Once: generate the keypair (admin machine, never the server)

```sh
uv run tools/drop_keygen.py            # writes drop-secret.key (0600), prints pubkey
```

**Back up `drop-secret.key` immediately** (password manager / encrypted
offline medium). It is the only thing that can decrypt drops — losing it makes
every received file permanently unreadable. `.gitignore` excludes `*.key`, but
the working rule is simpler: the key never leaves your machine.

### 2. Once: provision (on the VM)

Prerequisite: a DNS **A** record for the hostname. Add an AAAA only if the
host's IPv6 is pinned — see [server/README.md](../server/README.md) on SLAAC
rotation.

```sh
./setup_drop_server.sh -y \
    --slug woonzorglimburg_drop --port 5175 \
    --host aanleveren.woonzorglimburg.nl \
    --pubkey '<base64 from drop_keygen.py>' \
    --repo git@github.com:ObjectVision/northwake.git \
    --email you@example.com
```

### 3. Ongoing: senders upload

Point people at the page (`https://aanleveren.woonzorglimburg.nl/`) — or use
the CLI for bulk/scripted delivery:

```sh
uv run tools/drop_encrypt.py \
    --pubkey https://aanleveren.woonzorglimburg.nl/drop/pubkey \
    --upload https://aanleveren.woonzorglimburg.nl/drop \
    report.xlsx
```

### 3b. Ongoing: open and close the drop

The drop can be closed when no delivery is expected, so it never accumulates
personal data nobody is watching for. Over ssh, no sudo:

```sh
drop-toggle-<slug> status
drop-toggle-<slug> close --reason "Wij verwachten uw bestanden na 1 september."
drop-toggle-<slug> open
```

Direct commands for open/close:
DATA_DIR=/var/lib/woonzorglimburg_drop/drops   node /srv/woonzorglimburg_drop/drop-server/dist/cli.js close --reason "..."
DATA_DIR=/var/lib/woonzorglimburg_drop/drops   node /srv/woonzorglimburg_drop/drop-server/dist/cli.js open

Closed means a **polite refusal, not an outage**: the service keeps running,
`/drop/healthz` still answers 200 (with `accepting: false`, so monitoring does
not page), `/drop/pubkey` and `POST /drop` answer 503, and the page shows a
Dutch "gesloten" message carrying the `--reason` verbatim. Because the POST is
refused before the body is read, a closed drop never buffers an upload it will
discard.

State is `closed.json` in the data root — beside `drops/`, never inside it, so
`scp -r` and the sweep never see it. It survives restarts and deploys, and
changes take effect on the next request: **nothing to restart**. Closing never
touches already-stored drops; retrieve those the usual way (below). An
unreadable state file fails **open** — better an unintended open drop than
silently swallowing deliveries a sender believes succeeded.

### 4. Ongoing: admin retrieves and decrypts (admin machine)

```sh
scp -r deploy@<host>:/var/lib/woonzorglimburg_drop/drops ./drops-$(date +%Y%m%d)/
uv run tools/drop_decrypt.py --key drop-secret.key ./drops-*/
```

`drop_decrypt.py` verifies each blob's sha256 against its sidecar (catches
truncated copies), opens the sealed box, and writes plaintext to
`decrypted/<uuid>-<filename>`. Then **delete processed drops on the server**
(the `.bin` + `.json` pairs) — or let `DROP_TTL_DAYS` do it.

Note that scp is a convenience, not the safeguard: the blobs are ciphertext,
so confidentiality never depends on the transfer.

### 5. Periodically: roll the keypair

Rotate on a schedule (yearly is a reasonable default) and **immediately** on:
suspected exposure of `drop-secret.key`, loss or reinstall of the admin
machine, or a change of key custodian.

Only one thing has to change: the `DROP_PUBLIC_KEY` line in the systemd unit.
The public key is not baked into the page, the repo, or any config — the page
fetches it from `/drop/pubkey` at load time — so **no redeploy is involved**.

Rotation protects *future* drops only. Anything already sealed to the old key
stays readable only with the old private key, so the safe order is
**drain first, then switch**:

```sh
# 1. Admin machine — new keypair beside the old one. Note the dated filename:
#    drop_keygen.py REFUSES to overwrite an existing key file, by design.
uv run tools/drop_keygen.py --out drop-secret-$(date +%Y%m%d).key   # prints <newpub>

# 2. Close the drop, so nothing arrives mid-switch and every stored blob
#    belongs to exactly one key generation.
ssh deploy@<host> drop-toggle-woonzorglimburg_drop close \
    --reason "Onderhoud, probeert u het over een uur opnieuw."

# 3. Drain: retrieve everything sealed to the OLD key, decrypt, then delete it
#    from the server. After this, the old key has no blobs left to open.
scp -r deploy@<host>:/var/lib/woonzorglimburg_drop/drops ./drops-$(date +%Y%m%d)/
uv run tools/drop_decrypt.py --key drop-secret.key ./drops-*/
ssh deploy@<host> 'rm -f /var/lib/woonzorglimburg_drop/drops/*.bin \
                        /var/lib/woonzorglimburg_drop/drops/*.json'

# 4. Server — swap the key in the unit and restart.
sudo sed -i 's|^Environment=DROP_PUBLIC_KEY=.*|Environment=DROP_PUBLIC_KEY=<newpub>|' \
    /etc/systemd/system/drop-woonzorglimburg_drop.service
sudo systemctl daemon-reload
sudo systemctl restart drop-woonzorglimburg_drop

# 5. Verify BEFORE reopening — see the note below on why this step is not optional.
systemctl is-active drop-woonzorglimburg_drop
curl -s https://aanleveren.woonzorglimburg.nl/drop/healthz

# 6. Reopen, then prove the new key end to end with a throwaway file.
ssh deploy@<host> drop-toggle-woonzorglimburg_drop open
curl -s https://aanleveren.woonzorglimburg.nl/drop/pubkey    # must equal <newpub>
uv run tools/drop_encrypt.py \
    --pubkey https://aanleveren.woonzorglimburg.nl/drop/pubkey \
    --upload https://aanleveren.woonzorglimburg.nl/drop  rotation-test.txt
# then scp + drop_decrypt.py --key drop-secret-<date>.key, and delete the test drop
```

Finally, rename the new key to `drop-secret.key`, back it up, record the
changeover date in your key-custody note, and destroy the old key **and its
backups** — but only once step 3 confirms nothing sealed to it remains.

Four things to know before you run this:

- **A bad key value is an outage, not a warning.** `publicKey()` in
  [src/config.ts](src/config.ts) base64-decodes `DROP_PUBLIC_KEY`, requires
  exactly 32 bytes, and re-encodes to check the round trip; anything else
  throws at startup and the service will not come up. Hence step 5 before
  step 6 — a closed drop is a polite message, a crashed one is a broken site.
- **Already-open browser tabs keep the old key.** The page fetches
  `/drop/pubkey` once per page load (`cache: "no-store"`, so nothing is cached
  at the HTTP layer, but the value is held for the tab's lifetime). A sender
  who loaded the page before the switch and uploads after it produces a blob
  sealed to the *old* key. Closing the drop across the switch (step 2) makes
  those tabs fail loudly instead; if you skip the close, keep the old key until
  you have decrypted everything received around the changeover.
- **`drop_decrypt.py` takes one `--key`.** With a mixed directory, run it once
  per key over the same directory. Blobs from the other generation report
  `sealed box would not open (wrong key or tampered blob)` and the run exits 1
  — expected in that situation, but it means the exit code cannot be trusted as
  a "nothing failed" signal.
- **Re-running `setup_drop_server.sh --pubkey <newpub>` also works** and is
  idempotent, but it rewrites the unit, the nginx site and the deploy hook.
  Prefer the two-line edit above for a key change; keep the full script for
  when the whole instance is being reprovisioned.

## Abuse & overload guards

All env-tunable via systemd `Environment=` lines (see the unit written by the
setup script); safe finite defaults apply when unset. nginx adds an outer wall
(`client_max_body_size 201m`, `limit_req zone=drop`).

| guard | env | default |
|---|---|---|
| P0 max upload size | `MAX_DROP_BYTES` | 200 MB (declared length checked, stream cut off if it lies) |
| P1 input hygiene | `MAX_FILENAME_LEN` | octet-stream only; ≥ 48 bytes (sealed-box overhead); filename sanitized, 200 chars |
| P2 rate limit | `RATE_WINDOW_MS`, `RATE_MAX_DROPS_PER_WINDOW` | 10 drops / 60 s per IP (plus nginx 6r/m) |
| P3 retention | `DROP_MAX_AGE_WARN_DAYS`, `DROP_TTL_DAYS`, `SWEEP_INTERVAL_MS` | warn after 30 d awaiting pickup; TTL off (0) — enable to enforce a bewaartermijn |
| P4 total storage | `STORAGE_WARN_BYTES`, `STORAGE_MAX_BYTES` | warn at 1 GB, refuse (HTTP 507) at 2 GB |
| P5 open/closed | none (state file, see §3b) | open; `drop-toggle` closes it — refuses everything (HTTP 503) until reopened |

## Security model & AVG (GDPR)

**What the E2E design buys.** The server holds only ciphertext and the public
key. A full compromise of the process, the VM, its disk, or its backups
discloses no personal data without the admin's private key. This is the
compensating control for hosting on a shared, non-disk-encrypted VM. The
in-transit path is doubly covered (TLS around an already-sealed payload).

**What it does not buy.**
- The moment `drop_decrypt.py` writes plaintext, protection — and AVG
  responsibility — moves to the admin machine. Decrypt onto an encrypted disk;
  honour the retention policy; delete server-side copies once processed.
- A leaked private key exposes **everything sealed to it, past and future**.
  Rotation (§5) protects future drops only. Treat a leak as an incident:
  retrieve + delete stored blobs, then roll the keypair immediately.
- Nothing authenticates *senders*: anyone with the URL can upload. That is by
  design (guards bound the abuse) — the service accepts data, it never returns
  any.
- Metadata is minimized but not zero: the sidecar stores receive time, size,
  sha256 and the sender-declared filename. **No client IP is stored** and the
  nginx `access_log` is off for `/drop`. Filenames chosen by senders can
  themselves be personal data — treat retrieved sidecars accordingly.

**Organisational duties (not solvable in code).**
- A **verwerkersovereenkomst** with the hosting provider (TransIP) is required
  when personal data is processed on the VM — encrypted or not, storing it is
  processing under the AVG.
- The **DPIA** duty (if the data warrants one) lies with the
  verwerkingsverantwoordelijke, not with this software.
- Define a **bewaartermijn** and either enforce it operationally (delete after
  pickup) or via `DROP_TTL_DAYS`.
- Key custody: document who holds `drop-secret.key`, where its backup lives,
  when it was last rolled, and on what cadence (§5).

## Development

```sh
cd drop-server
npm install
npm test                      # 30 tests: guards, HTTP integration, open/close gate, crypto round trip
npm run page:vendor           # copy libsodium UMD builds into page/vendor/
DROP_PUBLIC_KEY=<b64> npm run dev

# open/close locally (same CLI the server wrapper execs)
DATA_DIR=./data/drops npm run toggle -- close --reason "test"
DATA_DIR=./data/drops npm run toggle -- status
```

Cross-language check (proves PyNaCl ↔ libsodium-wrappers interop locally):

```sh
uv run tools/drop_keygen.py --out /tmp/test.key         # prints <pub>
uv run tools/drop_encrypt.py --pubkey '<pub>' somefile  # -> somefile.sealed
node -e "const {createRequire}=require('module');const s=require('libsodium-wrappers');const fs=require('fs');s.ready.then(()=>{const sk=Buffer.from(fs.readFileSync('/tmp/test.key','utf8').trim(),'base64');const pk=s.crypto_scalarmult_base(sk);const out=s.crypto_box_seal_open(fs.readFileSync('somefile.sealed'),pk,sk);fs.writeFileSync('somefile.out',out);console.log('opened',out.length,'bytes')})"
diff somefile somefile.out
```
