#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "pynacl>=1.5",
# ]
# ///
"""Decrypt retrieved drops — run on the ADMIN machine, never the server.

Workflow:
    scp -r deploy@<host>:/var/lib/<slug>/drops ./drops-YYYYMMDD/
    uv run tools/drop_decrypt.py --key drop-secret.key ./drops-YYYYMMDD/

For every ``<uuid>.bin`` in the directory this verifies the ciphertext sha256
against its ``<uuid>.json`` sidecar (catches truncated copies before a
confusing decryption error), opens the sealed box, and writes the plaintext to
``decrypted/<uuid>-<filename>`` — uuid-prefixed so two uploads that were both
named ``gegevens.xlsx`` cannot overwrite each other.

Sealed boxes are authenticated (Poly1305): a tampered or corrupted blob FAILS
to open rather than yielding garbage, and is reported per file.

Remember: the moment this writes plaintext, AVG duties move to this machine —
decrypt onto an encrypted disk and honour the bewaartermijn.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import sys
from pathlib import Path

from nacl.exceptions import CryptoError
from nacl.public import PrivateKey, SealedBox


def load_private_key(path: Path) -> PrivateKey:
    raw = base64.b64decode(path.read_text().strip(), validate=True)
    if len(raw) != 32:
        raise ValueError(f"{path} does not contain a 32-byte base64 key")
    return PrivateKey(raw)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--key", required=True, type=Path, help="path to drop-secret.key")
    parser.add_argument("dir", type=Path, help="directory of <uuid>.bin/.json pairs (scp'd from the server)")
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="output directory (default: <dir>/decrypted)",
    )
    args = parser.parse_args()

    try:
        box = SealedBox(load_private_key(args.key))
    except Exception as err:  # noqa: BLE001
        print(f"Could not load private key: {err}", file=sys.stderr)
        return 1

    blobs = sorted(args.dir.glob("*.bin"))
    if not blobs:
        print(f"No .bin files found in {args.dir}", file=sys.stderr)
        return 1

    out_dir = args.out or (args.dir / "decrypted")
    out_dir.mkdir(parents=True, exist_ok=True)

    ok = 0
    failures = 0
    for blob in blobs:
        ciphertext = blob.read_bytes()
        sidecar = blob.with_suffix(".json")

        label = blob.stem
        filename = ""
        if sidecar.is_file():
            meta = json.loads(sidecar.read_text(encoding="utf-8"))
            filename = meta.get("filename") or ""
            expected = meta.get("sha256")
            actual = hashlib.sha256(ciphertext).hexdigest()
            if expected and actual != expected:
                print(f"FAIL {blob.name}: sha256 mismatch (truncated copy?) — re-transfer it", file=sys.stderr)
                failures += 1
                continue
        else:
            print(f"WARN {blob.name}: no sidecar; decrypting anyway", file=sys.stderr)

        try:
            plaintext = box.decrypt(ciphertext)
        except CryptoError:
            print(f"FAIL {blob.name}: sealed box would not open (wrong key or tampered blob)", file=sys.stderr)
            failures += 1
            continue

        target = out_dir / (f"{label}-{filename}" if filename else label)
        target.write_bytes(plaintext)
        received = ""
        if sidecar.is_file():
            received = f" (received {json.loads(sidecar.read_text(encoding='utf-8')).get('receivedAt', '?')})"
        print(f"OK   {blob.name} -> {target}{received}")
        ok += 1

    print(f"\n{ok} decrypted, {failures} failed, output in {out_dir}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
