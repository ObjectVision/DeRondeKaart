#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "pynacl>=1.5",
# ]
# ///
"""Generate the drop-server keypair — run on the ADMIN machine, never the server.

Writes the X25519 private key to ``drop-secret.key`` (base64, mode 0600) and
prints the matching public key. The public key goes into the server's systemd
unit (``Environment=DROP_PUBLIC_KEY=...`` — pass it to
``server/setup_drop_server.sh --pubkey``); the private key stays here.

The private key is the ONLY thing that can decrypt received drops:
  * losing it makes every stored drop permanently unreadable — back it up to a
    password manager or encrypted offline medium immediately;
  * leaking it exposes every drop sealed to it — rotation protects future
    uploads only, so treat a leak as an incident (pull + delete stored blobs).

Usage:
    uv run tools/drop_keygen.py [--out drop-secret.key]
"""

from __future__ import annotations

import argparse
import base64
import os
import sys
from pathlib import Path

from nacl.public import PrivateKey


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--out",
        default="drop-secret.key",
        help="private-key output path (default: drop-secret.key)",
    )
    args = parser.parse_args()

    out = Path(args.out)
    if out.exists():
        print(f"REFUSING to overwrite existing key file: {out}", file=sys.stderr)
        print("If you really want a new keypair, move the old file away first —", file=sys.stderr)
        print("it may be the only way to read drops already on the server.", file=sys.stderr)
        return 1

    key = PrivateKey.generate()
    secret_b64 = base64.b64encode(bytes(key)).decode()
    public_b64 = base64.b64encode(bytes(key.public_key)).decode()

    # 0600 before content: never readable by others, not even briefly.
    fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(secret_b64 + "\n")

    print(f"Private key written to {out} (mode 600). BACK IT UP — without it,")
    print("every drop ever received is permanently unreadable.\n")
    print("Public key (for the server; safe to share):\n")
    print(f"  {public_b64}\n")
    print("Provision with:")
    print(f"  server/setup_drop_server.sh --pubkey '{public_b64}' ...")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
