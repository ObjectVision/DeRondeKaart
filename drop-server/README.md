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
| `src/` | zero-dependency `node:http` service: `POST /drop`, `GET /drop/pubkey`, `GET /drop/healthz`, bound to 127.0.0.1 behind nginx |
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
  Rotation (new keypair, update `DROP_PUBLIC_KEY`, restart) protects future
  drops only. Treat a leak as an incident: retrieve + delete stored blobs.
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
  and the rotation procedure above.

## Development

```sh
cd drop-server
npm install
npm test                      # 19 tests: guards, HTTP integration, crypto round trip
npm run page:vendor           # copy libsodium UMD builds into page/vendor/
DROP_PUBLIC_KEY=<b64> npm run dev
```

Cross-language check (proves PyNaCl ↔ libsodium-wrappers interop locally):

```sh
uv run tools/drop_keygen.py --out /tmp/test.key         # prints <pub>
uv run tools/drop_encrypt.py --pubkey '<pub>' somefile  # -> somefile.sealed
node -e "const {createRequire}=require('module');const s=require('libsodium-wrappers');const fs=require('fs');s.ready.then(()=>{const sk=Buffer.from(fs.readFileSync('/tmp/test.key','utf8').trim(),'base64');const pk=s.crypto_scalarmult_base(sk);const out=s.crypto_box_seal_open(fs.readFileSync('somefile.sealed'),pk,sk);fs.writeFileSync('somefile.out',out);console.log('opened',out.length,'bytes')})"
diff somefile somefile.out
```
