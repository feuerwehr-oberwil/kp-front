"""Generate a VAPID key pair for Web Push — no Node/npx needed on the server.

Usage::

    cd backend && uv run python -m app.gen_vapid

Prints ``VAPID_PUBLIC_KEY`` / ``VAPID_PRIVATE_KEY`` in the URL-safe base64 form pywebpush
(and the browser's ``applicationServerKey``) expect: the public key as an uncompressed
P-256 point (65 bytes), the private key as the raw 32-byte scalar. Paste both into the
deployment env (``.env`` / Railway variables); generate ONCE and keep the pair stable —
rotating it invalidates every stored subscription.
"""

import base64

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def generate() -> tuple[str, str]:
    """Return a fresh ``(public, private)`` VAPID pair as URL-safe base64."""
    key = ec.generate_private_key(ec.SECP256R1())
    public = key.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    private = key.private_numbers().private_value.to_bytes(32, "big")
    return _b64url(public), _b64url(private)


if __name__ == "__main__":
    pub, priv = generate()
    print(f"VAPID_PUBLIC_KEY={pub}")
    print(f"VAPID_PRIVATE_KEY={priv}")
