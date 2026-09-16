"""How far the SharePoint pull has got — in memory, for the card that is watching it.

The pull is ONE request that walks every configured area and answers when the last one is done
(`sharepoint_sync.sync_sharepoint`), and its per-area report is written in one transaction at the
end. That is right for the report — a half-written run must not be readable as a result — and it
leaves the operator with a spinner and no idea whether the 60 seconds they have been waiting are
one big Modul 6 or a stalled tenant.

So the run keeps a running note HERE, next to the request rather than in it:

* **Memory, never the database.** It is not a fact about the deployment, it is what one process
  is doing this minute; writing it would mean committing inside the run, which is exactly the
  transactional split the report deliberately avoids.
* **One process.** The station runs a single uvicorn worker (`backend/start.sh`), so the poll
  reaches the process that is syncing. If that ever changes, a poll landing on another worker
  reads «nothing running», and the card falls back to the indeterminate bar it draws when the
  server says nothing — degraded, never wrong.
* **Best effort throughout.** Nothing here may raise into a sync: a missed `step()` costs a
  progress bar, and a raise would cost the run.

The scheduler's nightly pull goes through the same function, so opening the System page at 05:03
shows that run too — which is the first time that has been visible at all.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class SyncProgress:
    """One run, as far as it has got."""

    started_at: datetime
    #: the areas this run will walk, in order
    areas: list[str] = field(default_factory=list)
    #: which one it is in, and how many are behind it
    area: str | None = None
    areas_done: int = 0
    #: files within the current area — 0/0 while an area is resolving folders or listing
    done: int = 0
    total: int = 0


_current: SyncProgress | None = None


def begin(areas: list[str]) -> None:
    """A run starts. Replaces whatever was there: a previous run that never called `finish`
    (a process killed mid-sync) must not outlive the one that is actually running."""
    global _current
    _current = SyncProgress(started_at=datetime.now(UTC), areas=list(areas))


def area(name: str) -> None:
    """…and moves on to the next area. The files of the previous one are done with it."""
    if _current is None:
        return
    if _current.area is not None:
        _current.areas_done += 1
    _current.area = name
    _current.done = _current.total = 0


def files(total: int) -> None:
    """How many files THIS area will work through, once the walk has said so."""
    if _current is not None:
        _current.total = max(0, total)


def step(n: int = 1) -> None:
    """One more file done."""
    if _current is not None:
        _current.done += n


def finish() -> None:
    """The run is over — by success, by failure, or by the request being cancelled."""
    global _current
    _current = None


def snapshot() -> dict[str, Any]:
    """What the card polls. Always answers; `running: false` when nothing is going on."""
    p = _current
    if p is None:
        return {"running": False}
    return {
        "running": True,
        "startedAt": p.started_at.isoformat(),
        "area": p.area,
        "areas": list(p.areas),
        "areasDone": p.areas_done,
        "areasTotal": len(p.areas),
        "done": p.done,
        "total": p.total,
    }
