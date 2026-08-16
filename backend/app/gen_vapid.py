"""Generate a VAPID key pair for Web Push — no Node/npx needed on the server.

Usage::

    cd backend && uv run python -m app.gen_vapid                  # with the toolchain
    docker compose exec app uv run python -m app.gen_vapid        # on a station server

Prints ``VAPID_PUBLIC_KEY`` / ``VAPID_PRIVATE_KEY`` in the URL-safe base64 form pywebpush
(and the browser's ``applicationServerKey``) expect: the public key as an uncompressed
P-256 point (65 bytes), the private key as the raw 32-byte scalar.

⚠️ **Both halves belong in /admin → Zugangsdaten, not in ``.env``.** A value present in the
environment outranks the credential store and *locks* that field in the browser: the station
then cannot rotate its own push keys without a shell and a restart, which is the outcome the
credential store exists to prevent. ``.env`` / Railway variables remain the deliberate way to
pin the pair to the deployment's environment – a choice, never the default. ``scripts/setup.sh``
mints the pair into the store on a fresh install, so this command is for an older install or a
rotation.

Generate ONCE and keep the pair stable – rotating it invalidates every stored subscription, and
setting only one half leaves push "configured" and silently unable to deliver.
"""

import base64
import sys

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def generate() -> tuple[str, str]:
    """Return a fresh ``(public, private)`` VAPID pair as URL-safe base64."""
    key = ec.generate_private_key(ec.SECP256R1())
    public = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    private = key.private_numbers().private_value.to_bytes(32, "big")
    return _b64url(public), _b64url(private)


if __name__ == "__main__":
    pub, priv = generate()
    print(f"VAPID_PUBLIC_KEY={pub}")
    print(f"VAPID_PRIVATE_KEY={priv}")
    # On stderr, so the two lines above stay pipeable. The advice is here and not only in the
    # docs because this is where the operator is standing with a fresh pair in their terminal,
    # and the wrong destination costs them the ability to ever rotate it from the browser.
    print(
        "\nPaste BOTH halves into /admin -> Zugangsdaten -> Web Push. They take effect on the\n"
        "next request; no restart. Do NOT put them in .env unless you mean to: a value in the\n"
        "environment outranks the stored one and locks that field in /admin, so the station can\n"
        "no longer rotate its own push keys without a shell.\n"
        "Generate once and keep the pair stable - rotating it invalidates every subscription,\n"
        "and half a pair leaves push 'configured' and unable to deliver.",
        file=sys.stderr,
    )
