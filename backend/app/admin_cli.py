"""The plumbing the five station CLIs share — nothing domain-specific lives here.

``admin_config``, ``admin_geodata``, ``admin_objects``, ``admin_checklists`` and
``admin_branding`` are operator tools with the same shape: validate a file, write it into the
database directly, or ``push`` it to a RUNNING deployment over its HTTP API. What they had in
common was written out five times — the ``_fail`` that exits non-zero, the
``--base``/``--admin-secret``/``--dry-run`` flags with their environment fallbacks, the
"neither given" refusal, and the login-then-write httpx session.

``admin_branding`` shares the ``_fail`` and the session but keeps its own ``--secret`` flag and
its own two refusals: the flag name and those exact strings are quoted in the setup guide and
pinned by tests, and renaming an operator's flag to tidy a docstring is not a fix.

What is NOT here, deliberately: the subcommand skeleton and the ``push`` bodies. They look
alike from a distance and are not — one uploads GeoJSON and rewrites ``referenceLayers``
under an ``If-Match``, one PUTs objects and their plan PDFs, one refuses to empty a populated
section without ``--force``. A skeleton wide enough for all of them would take more reading
than the five it replaced.

⚠️ These are operator tools and their output IS their interface — the setup guide quotes it.
Every message here is the wording the five already printed; changing one changes documentation.
"""

import argparse
import os
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import httpx


def fail(message: str) -> None:
    """Print an error to stderr and exit non-zero (nothing written)."""
    print(message, file=sys.stderr)
    raise SystemExit(1)


def add_base_arg(parser: argparse.ArgumentParser) -> None:
    """``--base``, defaulting to ``KP_BASE_URL`` — for any subcommand that talks to a deployment."""
    parser.add_argument("--base", default=os.environ.get("KP_BASE_URL"), help="deployment base URL (env KP_BASE_URL)")


def add_push_args(parser: argparse.ArgumentParser, *, dry_run_help: str) -> None:
    """The three flags every ``push`` subcommand takes.

    ``dry_run_help`` is the one part that differs per CLI (what a dry run would have uploaded),
    and it is the help text an operator reads, so it stays the caller's word.
    """
    add_base_arg(parser)
    parser.add_argument(
        "--admin-secret",
        default=os.environ.get("KP_ADMIN_SECRET"),
        help="deployment ADMIN_SECRET (env KP_ADMIN_SECRET)",
    )
    parser.add_argument("--dry-run", action="store_true", help=dry_run_help)


def require_push_target(args: argparse.Namespace) -> None:
    """Refuse a ``push`` with no deployment to push to. Names both the flags and the env vars,
    because an operator following the setup guide has usually set one of the two."""
    if not args.base or not args.admin_secret:
        fail("ERROR: push needs --base and --admin-secret (or KP_BASE_URL / KP_ADMIN_SECRET).")


@contextmanager
def admin_client(base: str, admin_secret: str, *, timeout: float) -> "Iterator[httpx.Client]":
    """An httpx session already logged in as the deployment admin, or exit non-zero.

    The ADMIN_SECRET handshake (not an editor PIN): whoever can push station data is
    administering the deployment. The session cookie the login sets rides on the client, so
    the caller just makes its requests.

    ``base`` is used verbatim in the failure message and only stripped of a trailing slash for
    the client — the CLIs that print the base themselves normalise it before they call.
    """
    import httpx  # lazy: only the network paths need it

    with httpx.Client(base_url=base.rstrip("/"), timeout=timeout) as c:
        r = c.post("/api/admin/login", json={"secret": admin_secret})
        if r.status_code != 200:
            fail(f"ERROR: admin login to {base} failed ({r.status_code}): {r.text[:200]}")
        yield c
