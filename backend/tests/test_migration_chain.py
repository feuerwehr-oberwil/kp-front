"""The alembic revision chain must resolve — a migration shipped once with `down_revision`
pointing at an untracked WIP file (c4d82e9f1a37 → b2f61c8d5e30), and `alembic upgrade head`
threw `KeyError` on boot on every deployed image, aborting `start.sh` before uvicorn came up.

This walks the chain purely at the file level (no database) so a broken parent is caught in
CI rather than at deploy time. It deliberately does NOT assert exactly one head: a sibling
session's local, untracked WIP migration is allowed to fork the chain on a dev machine — CI
only ever sees the committed tree.
"""

from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory

BACKEND_DIR = Path(__file__).resolve().parent.parent


def test_alembic_chain_resolves() -> None:
    config = Config(str(BACKEND_DIR / "alembic.ini"))
    # alembic.ini's script_location is relative to the CWD alembic is invoked from, not to the
    # ini file itself — pin it so this test passes regardless of where pytest runs from.
    config.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    script = ScriptDirectory.from_config(config)

    heads = script.get_heads()
    assert heads, "no heads found — alembic/versions is empty or unreadable"

    for head in heads:
        try:
            # Materializing the iterator forces alembic to resolve every down_revision link
            # from this head back to "base" — an unresolvable one raises here.
            list(script.walk_revisions(base="base", head=head))
        except Exception as exc:  # alembic.util.exc.CommandError names the missing revision id
            raise AssertionError(f"revision chain from head {head!r} does not resolve to base: {exc}") from exc
