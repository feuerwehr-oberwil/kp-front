"""The upstream ingest credential — deliberately public, and worth almost nothing.

WHY A SECRET IS SITTING IN A PUBLIC REPOSITORY
==============================================

The string below is a Sentry/GlitchTip DSN. Its middle section is a *public key*, and in
Sentry's design that is a write-only credential by construction: the ingest endpoint it
authenticates (``POST /api/<project>/envelope/``) accepts events and returns 200. There is
no read verb behind it. It cannot list events, cannot read a stored event, cannot reach any
other project, cannot log in to the GlitchTip UI, and cannot be escalated into anything
that can. Reading requires a session on the ingest server, which this key has no path to.

So it is checked in, in the clear, on purpose — the same call every client-side error
reporter makes (Basic Memory's OpenPanel client key, Home Assistant's analytics endpoint,
every browser Sentry SDK ever shipped). A self-hoster who greps this repo for secrets
SHOULD find this one and SHOULD be able to satisfy themselves in thirty seconds that it
does not read their data. That is the point of putting it here rather than behind an env
var that looks like it is hiding something.

What someone who copies it CAN do is post junk events into the project. That is the entire
threat model, it is a nuisance rather than a breach, and it is handled on the ingest side
(per-install and per-IP rate limits, GlitchTip spike protection, a project quota, and an
ingest host that is network-isolated from anything of ours) rather than by pretending the
key is a secret. See deploy/ingest/README.md.

WHAT A SELF-HOSTER CAN DO WITH IT
=================================

Override ``KP_TELEMETRY_DSN`` to point at your own GlitchTip and upstream never hears from
you — the feature keeps working, aimed at your own server. Set it to the empty string (or
``KP_TELEMETRY_ENABLED=0``) and the forwarder is compiled out of the running process
regardless of what any admin later clicks in the UI: env beats consent, so a station that
forbids outbound traffic can enforce that centrally and not worry about the setting.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# The upstream ingest. Public by design — read the module docstring before "fixing" this.
#
# NOTE: until the ingest host is actually deployed this is the documented placeholder shape
# and NOT a live key. `parse_dsn` rejects it, so the forwarder stays a no-op and no instance
# can dribble events at a hostname that doesn't exist yet. Replacing it is a one-line change
# once deploy/ingest/ is up.
UPSTREAM_DSN = "https://PLACEHOLDER_PUBLIC_KEY@ingest.kp-front.ch/1"

_PLACEHOLDER = "PLACEHOLDER_PUBLIC_KEY"

_DSN_RE = re.compile(
    r"^(?P<scheme>https?)://(?P<key>[0-9a-z]+)@(?P<host>[^/]+)/(?P<project>\d+)$", re.I
)


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

    Returning None rather than raising is the whole contract: a malformed DSN, an empty
    override, or the placeholder above must all degrade to "we don't send", never to a
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
