"""The last few crashes, kept in memory, so a Rückmeldung can carry a stack trace.

WHY THIS EXISTS
===============

Without it the manual report is a sentence and a build number. That is enough to say
«something broke» and not enough to fix anything — the maintainer's first reply is always
"do you have the actual error", by which time the operator has closed the app and the
moment is gone. This module is the answer to that reply, prepared in advance.

The station's own server log already has every one of these lines (``api/diag.py`` logs each
client error at WARNING before anything else happens). That copy is the durable record. This
one exists because a log file is not something an operator can attach to an e-mail: it is on
the server, it needs a shell, and it is full of everything else. So we keep the same content
in a form the app can hand over as a file.

WHY IN MEMORY, AND NOT A TABLE
==============================

Because of what it is for. A report is written minutes after the thing went wrong — that is
the whole premise of the trouble prompt — so a buffer that survives the process is solving a
problem nobody has, at the cost of a migration, a retention policy, and a second store of
error text to reason about in PRIVACY.md. Anything older than this process is still in the
log, where it belongs.

It is also why this module deliberately does NOT touch consent. Nothing here leaves the
machine: the buffer is read by one endpoint, that endpoint is served to a logged-in user of
this deployment, and it reaches us only if that person exports it and attaches it to a mail
themselves. Consent gates transmission, and this module does not transmit.

WHAT GOES IN
============

Already-scrubbed fields only — the caller runs ``scrub.build_error`` first and hands the
result here. This module does no sanitising of its own, for the same reason ``envelope.py``
does none: re-scrubbing at the last moment hides the fact that some caller forgot to.
"""

from __future__ import annotations

import contextlib
from collections import deque
from datetime import UTC, datetime
from typing import Any

#: How many crashes are worth keeping. A wedged app produces the same error dozens of times
#: and the story is told by the first few; past this the buffer would just be one stack trace
#: repeated, and the export would be harder to read rather than more complete.
MAX_RECENT = 50

_recent: deque[dict[str, Any]] = deque(maxlen=MAX_RECENT)


def record(*, error: dict[str, Any], release: str | None = None, device: str | None = None) -> None:
    """Note one already-sanitised error. Never raises — this runs on the crash path.

    ``suppress`` rather than try/except/pass, and deliberately broad: there is no failure here
    worth propagating. The caller is the error sink itself, so an exception thrown while
    recording an exception would replace a report we can act on with one we cannot.
    """
    with contextlib.suppress(Exception):
        _recent.append(
            {
                "at": datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z"),
                "kind": error.get("kind", "error"),
                "message": error.get("message", ""),
                "stack": error.get("stack", ""),
                "componentStack": error.get("componentStack", ""),
                "path": error.get("path", ""),
                **({"release": release} if release else {}),
                **({"device": device} if device else {}),
            }
        )


def snapshot() -> list[dict[str, Any]]:
    """Oldest first, so the export reads like a timeline. A copy — callers may not mutate."""
    return list(_recent)


def count() -> int:
    return len(_recent)


def clear() -> None:
    """Drop everything. Module-level state outlives a test, so tests reset through this."""
    _recent.clear()
