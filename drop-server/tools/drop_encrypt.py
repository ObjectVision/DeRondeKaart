#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "pynacl>=1.5",
# ]
# ///
"""Seal files to the drop-server public key — and optionally upload them.

The browser page does this same sealing client-side; this tool covers
everything the page doesn't: bulk/out-of-band sends, scripted delivery, and
testing the pipeline without a browser. Output is a NaCl sealed box
(``crypto_box_seal``), byte-compatible with what the page produces and with
what ``drop_decrypt.py`` opens.

``--pubkey`` accepts either the base64 key itself or the server's pubkey URL
(``https://aanleveren.woonzorglimburg.nl/drop/pubkey``), from which it is
fetched.

Usage:
    # seal to .sealed files next to the originals
    uv run tools/drop_encrypt.py --pubkey <base64> report.xlsx foto.jpg

    # seal and POST straight to the server
    uv run tools/drop_encrypt.py \\
        --pubkey https://aanleveren.woonzorglimburg.nl/drop/pubkey \\
        --upload https://aanleveren.woonzorglimburg.nl/drop \\
        report.xlsx
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

from nacl.public import PublicKey, SealedBox


def resolve_pubkey(value: str) -> PublicKey:
    """Accept a base64 key or a URL serving {"publicKey": "<base64>"}."""
    if value.startswith(("http://", "https://")):
        with urllib.request.urlopen(value, timeout=30) as res:
            value = json.load(res)["publicKey"]
    raw = base64.b64decode(value, validate=True)
    if len(raw) != 32:
        raise ValueError("public key must be 32 bytes of base64")
    return PublicKey(raw)


def upload(url: str, ciphertext: bytes, filename: str) -> str:
    req = urllib.request.Request(
        url,
        data=ciphertext,
        method="POST",
        headers={
            "Content-Type": "application/octet-stream",
            "X-Drop-Filename": urllib.parse.quote(filename),
        },
    )
    with urllib.request.urlopen(req, timeout=300) as res:
        return json.load(res)["id"]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--pubkey", required=True, help="base64 public key, or the /drop/pubkey URL")
    parser.add_argument("--upload", metavar="URL", help="POST sealed files to this /drop endpoint")
    parser.add_argument("files", nargs="+", type=Path, help="files to seal")
    args = parser.parse_args()

    try:
        box = SealedBox(resolve_pubkey(args.pubkey))
    except Exception as err:  # noqa: BLE001 — one clear message beats a traceback
        print(f"Could not resolve public key: {err}", file=sys.stderr)
        return 1

    failures = 0
    for path in args.files:
        if not path.is_file():
            print(f"SKIP {path}: not a file", file=sys.stderr)
            failures += 1
            continue
        ciphertext = box.encrypt(path.read_bytes())
        if args.upload:
            try:
                drop_id = upload(args.upload, ciphertext, path.name)
                print(f"{path}: uploaded, kenmerk {drop_id}")
            except Exception as err:  # noqa: BLE001
                print(f"FAIL {path}: upload failed: {err}", file=sys.stderr)
                failures += 1
        else:
            out = path.with_name(path.name + ".sealed")
            out.write_bytes(ciphertext)
            print(f"{path} -> {out} ({len(ciphertext)} bytes)")

    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
