"""tests/db_guard.py: the suite refuses any database that is not a local throwaway one."""

import pytest
from db_guard import refusal

PASSWORD = "s3cret-pw"


@pytest.mark.parametrize(
    ("dsn", "why"),
    [
        (f"postgresql+asyncpg://kp:{PASSWORD}@db.railway.internal:5432/kpfront_test", "not on this machine"),
        # The dev database, or a production database tunnelled to a local port.
        (f"postgresql+asyncpg://kp:{PASSWORD}@localhost:5434/kpfront", "not a test database"),
        (f"postgresql+asyncpg://kp:{PASSWORD}@127.0.0.1:6543/railway", "not a test database"),
        (f"postgresql+asyncpg://kp:{PASSWORD}@localhost/kpfront_test?host=db.example.com", "connection options"),
        ("postgresql+asyncpg:///kpfront_test", "not on this machine"),
        ("sqlite+aiosqlite:///./prod-copy.db", "not Postgres"),
        (f"postgresql+asyncpg://kp:{PASSWORD}@localhost:x/kpfront_test", "not a database URL"),
    ],
)
def test_refuses_anything_but_a_local_test_database(dsn: str, why: str) -> None:
    reason = refusal(dsn)
    assert reason is not None
    assert why in reason
    assert PASSWORD not in reason


@pytest.mark.parametrize(
    "dsn",
    [
        "",  # in-memory SQLite
        "postgresql+asyncpg://kpfront:kpfront@localhost:5432/kpfront_test",  # CI
        "postgresql+asyncpg://kpfront:kpfront@localhost:5434/kpfront_test_4711",  # just test-backend
        "postgresql://kpfront:kpfront@127.0.0.1:5434/kpfront_test",
    ],
)
def test_accepts_the_local_throwaway_databases(dsn: str) -> None:
    assert refusal(dsn) is None
