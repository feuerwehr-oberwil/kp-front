"""Unit tests for the replay reconstruction engine's pure selection logic.

`nearest_snapshot` picks the fold anchor — the latest snapshot whose occurred_at is
still <= the requested instant. It's a pure function over snapshot-like objects, so we
exercise it with lightweight stand-ins (no DB / no live server), matching the way the
existing audit-chain tests keep the legally-load-bearing logic under test in isolation.
"""

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from app.audit import nearest_snapshot


@dataclass
class _Snap:
    occurred_at: datetime
    seq_at: int = 0


_T0 = datetime(2026, 6, 19, 12, 0, 0, tzinfo=UTC)


def _snap(minutes: int, seq: int = 0) -> _Snap:
    return _Snap(occurred_at=_T0 + timedelta(minutes=minutes), seq_at=seq)


def test_no_snapshots_returns_none():
    assert nearest_snapshot([], _T0) is None


def test_all_future_snapshots_returns_none():
    snaps = [_snap(5), _snap(10)]
    assert nearest_snapshot(snaps, _T0) is None


def test_picks_latest_at_or_before_instant():
    snaps = [_snap(0, 1), _snap(5, 2), _snap(10, 3)]
    at = _T0 + timedelta(minutes=7)
    chosen = nearest_snapshot(snaps, at)
    assert chosen is not None
    assert chosen.seq_at == 2  # the 5-minute one, not the future 10-minute one


def test_exact_boundary_is_inclusive():
    snaps = [_snap(0, 1), _snap(5, 2)]
    chosen = nearest_snapshot(snaps, _T0 + timedelta(minutes=5))
    assert chosen is not None and chosen.seq_at == 2  # occurred_at <= at, boundary counts


def test_unordered_input_still_picks_greatest_eligible():
    # selection must not depend on input order
    snaps = [_snap(10, 3), _snap(0, 1), _snap(5, 2)]
    chosen = nearest_snapshot(snaps, _T0 + timedelta(minutes=6))
    assert chosen is not None and chosen.seq_at == 2


def test_after_all_snapshots_picks_last():
    snaps = [_snap(0, 1), _snap(5, 2)]
    chosen = nearest_snapshot(snaps, _T0 + timedelta(hours=1))
    assert chosen is not None and chosen.seq_at == 2
