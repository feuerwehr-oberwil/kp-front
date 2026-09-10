"""Where sanitised diagnostics may be sent — and by default, nowhere.

THERE IS NO UPSTREAM ANY MORE
=============================

This module used to carry a checked-in public DSN pointing at an ingest host we ran
(``ingest.kp-front.ch``, one GlitchTip, a project per app). That host was retired: it cost
more to keep alive than the handful of crash reports it received were worth, and every
install that opted in was one of ours anyway. Nothing in this app now has a destination it
did not get from its own deployer.

What replaced it is the LOCAL diagnostics buffer. Errors and manual reports are still built
and sanitised exactly as before, and they are still written to the station's own log and
its own ``telemetry_outbox`` table — they simply stop there, where the operator can read
them, export them, and decide for themselves whether to mail them to the maintainer. See
``recent.py`` for that buffer and ``app/api/diag.py`` for the export.

SO WHY IS THIS FILE STILL HERE
==============================

Because a self-hoster running their own GlitchTip is a real and supported case, and it costs
one string to keep supporting it. Set ``KP_TELEMETRY_DSN`` to your own ingest and the
forwarder starts delivering there. Leave it unset — the default, and what every deployment
now does — and :func:`parse_dsn` returns ``None``, which is the single "telemetry is off"
signal the forwarder reads. Off is not a special case here; it is the empty string.

The deployer veto is unchanged: ``KP_TELEMETRY_ENABLED=0`` compiles the forwarder out of the
running process regardless of what any admin later clicks. Env beats consent.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# No upstream. A deployment sends nowhere unless its own deployer sets KP_TELEMETRY_DSN to a
# GlitchTip/Sentry ingest they run. Empty is a valid, fully supported configuration — it is
# the one every station now has — and parse_dsn turns it into "off" rather than an error.
UPSTREAM_DSN = ""

_PLACEHOLDER = "PLACEHOLDER_PUBLIC_KEY"

_DSN_RE = re.compile(r"^(?P<scheme>https?)://(?P<key>[0-9a-z]+)@(?P<host>[^/]+)/(?P<project>\d+)$", re.I)


@dataclass(frozen=True)
class Dsn:
    """A parsed DSN, reduced to the two things the forwarder needs."""

    envelope_url: str
    public_key: str

    @property
    def auth_header(self) -> str:
        """Sentry's own auth header. ``sentry_key`` is the public key; there is no secret half
        (Sentry retired the secret key years ago precisely because clients are public)."""
        return f"Sentry sentry_version=7, sentry_client=kp/1.0, sentry_key={self.public_key}"


def parse_dsn(raw: str | None) -> Dsn | None:
    """Parse a DSN, or return None for "telemetry is off".

    Returning None rather than raising is the whole contract: an unset DSN (the default), a
    malformed one, or the placeholder above must all degrade to "we don't send", never to a
    crash. This is a diagnostics path — it is not allowed to become the thing that breaks
    an instance at 3am.
    """
    if not raw or _PLACEHOLDER in raw:
        return None
    m = _DSN_RE.match(raw.strip())
    if not m:
        return None
    scheme, key, host, project = m.group("scheme", "key", "host", "project")
    return Dsn(
        envelope_url=f"{scheme}://{host}/api/{project}/envelope/",
        public_key=key,
    )
