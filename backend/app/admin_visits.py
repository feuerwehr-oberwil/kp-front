"""Read the visit statistics from a terminal — the counterpart to GET /api/admin/visits.

Run from ``backend/`` via ``uv run python -m app.admin_visits``. It talks to whatever
``DATABASE_URL`` points at, so on Railway that is ``railway run uv run python -m app.admin_visits``.

    (no argument)          the last 30 days, one block per day
    --days N               a different window
    --totals               skip the per-day blocks, print the window's totals only
    --prune                delete dedup rows past the retention window, then exit

The numbers only exist where ``VISIT_STATS=true``, which is the public demo and nothing
else — on a station this prints an empty table, permanently and by design. See app/visits.py.
"""

import argparse
import asyncio
import sys
from collections import defaultdict

from . import visits
from .config import settings
from .database import async_session_maker

#: Reading order, coarse to fine — what the landing page saw, then the demo, then inside it.
_KIND_ORDER = ("page", "referrer", "demo", "feature")
_KIND_LABEL = {
    "page": "Landing page",
    "referrer": "Referrers",
    "demo": "Demo",
    "feature": "Features",
}


def _table(rows: list[tuple[str, int, int]], indent: str = "    ") -> str:
    """key / hits / uniques, with the key column sized to its longest entry."""
    width = max((len(k) for k, _, _ in rows), default=3)
    return "\n".join(f"{indent}{k.ljust(width)}  {h:>6}  {u:>6}" for k, h, u in rows)


def _block(title: str, buckets: dict[str, list[tuple[str, int, int]]]) -> str:
    out = [title]
    for kind in _KIND_ORDER:
        rows = buckets.get(kind)
        if not rows:
            continue
        out.append(f"  {_KIND_LABEL[kind]}{' ' * 2}(hits / uniques)")
        out.append(_table(sorted(rows, key=lambda r: (-r[1], r[0]))))
    return "\n".join(out)


async def _amain(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(prog="admin_visits", description=__doc__)
    ap.add_argument("--days", type=int, default=30, help="window in days (default 30)")
    ap.add_argument("--totals", action="store_true", help="totals for the window only")
    ap.add_argument("--prune", action="store_true", help="delete dedup rows past the retention window")
    args = ap.parse_args(argv)

    async with async_session_maker() as db:
        if args.prune:
            deleted = await visits.prune(db)
            await db.commit()
            print(f"OK: {deleted} dedup row(s) older than {visits.RETAIN_DAYS} days deleted (counters untouched).")
            return 0
        rows = await visits.read(db, args.days)

    if not settings.visit_stats:
        print("VISIT_STATS is off on this deployment — nothing is being counted here.\n", file=sys.stderr)
    if not rows:
        print(f"No visits recorded in the last {args.days} day(s).")
        return 0

    totals: dict[str, dict[str, list[int]]] = defaultdict(lambda: defaultdict(lambda: [0, 0]))
    per_day: dict[str, dict[str, list[tuple[str, int, int]]]] = defaultdict(lambda: defaultdict(list))
    for r in rows:
        per_day[r.day.isoformat()][r.kind].append((r.key, r.hits, r.uniques))
        agg = totals[r.kind][r.key]
        agg[0] += r.hits
        # ⚠️ A SUM, NOT A UNIQUE COUNT. Somebody who came back on three days is three here.
        # Deduping across days would need to compare hashes from days whose salt no longer
        # exists — the one thing this design guarantees is impossible. Say so rather than
        # letting the column header imply otherwise.
        agg[1] += r.uniques

    if not args.totals:
        for day in sorted(per_day, reverse=True):
            print(_block(day, per_day[day]))
            print()

    print(
        _block(
            f"Total, last {args.days} day(s)  —  uniques are summed per day, not deduped across days",
            {kind: [(key, v[0], v[1]) for key, v in keys.items()] for kind, keys in totals.items()},
        )
    )
    return 0


def main() -> None:
    sys.exit(asyncio.run(_amain(sys.argv[1:])))


if __name__ == "__main__":
    main()
