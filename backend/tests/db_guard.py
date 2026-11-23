"""Refuse a ``DATABASE_URL`` the test suite must not touch.

The suite drops and rebuilds its schema, so it may only run on a throwaway database. An
inherited ``DATABASE_URL`` (a shell pointed at a staging copy, a tunnel to production on a
local port) would otherwise be wiped by a plain ``pytest`` run. ``tests/conftest.py`` calls
``refusal`` in ``pytest_configure``, before any connection – which covers ``just test``,
``just test-backend``, ``just test-changed``, CI and a bare ``uv run pytest`` at once.

Accepted: no ``DATABASE_URL`` (in-memory SQLite), or Postgres on a loopback host whose database
is ``kpfront_test`` (CI) or ``kpfront_test_<suffix>`` (``just test-backend``, xdist workers).
The name check also refuses a real database tunnelled to a local port, and the dev database
``kpfront``.
"""

from sqlalchemy.engine import make_url
from sqlalchemy.exc import ArgumentError

TEST_DATABASE = "kpfront_test"
_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


def refusal(dsn: str) -> str | None:
    """None when the suite may run on ``dsn``, else why not. Never shows a password."""
    if not dsn:
        return None
    try:
        url = make_url(dsn)
    except (ArgumentError, ValueError):  # ValueError: a port that is not a number
        # Do not echo it: an unparsable value can still hold a password.
        return "DATABASE_URL is not a database URL"
    # Without the query: it can carry a password too.
    shown = url.set(query={}).render_as_string(hide_password=True)
    if url.get_backend_name() != "postgresql":
        return f"{shown} is not Postgres (unset DATABASE_URL for in-memory SQLite)"
    # SQLAlchemy hands query options to asyncpg as connect arguments: `?host=` replaces the host.
    # (A PGSERVICE host only applies when the URL names none, and that is refused below.)
    if url.query:
        return f"{shown} has connection options ({', '.join(sorted(url.query))})"
    if url.host not in _LOOPBACK_HOSTS:
        return f"{shown} is not on this machine (host {url.host!r})"
    name = url.database or ""
    if name != TEST_DATABASE and not name.startswith(f"{TEST_DATABASE}_"):
        return f"{shown} is not a test database ({TEST_DATABASE} or {TEST_DATABASE}_*)"
    return None
