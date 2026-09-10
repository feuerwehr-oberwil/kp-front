"""Opt-in, sanitised telemetry for a self-hosted app.

Read in this order:

* ``dsn.py``       — why there is no upstream any more, and what a self-hoster can still set
* ``scrub.py``     — the allow-list; the only place a field can be added to a payload
* ``envelope.py``  — the wire format, hand-written instead of an SDK, and why
* ``consent.py``   — who is allowed to decide, and what NULL means
* ``recent.py``    — the local crash buffer the operator's export hands over
* ``outbox.py``    — the queue, and the transparency log
* ``forwarder.py`` — the one place that can open a connection outward, and by default doesn't

Two channels, and the difference between them is the difference the whole design rests on:

  **error**  — background. Off unless an admin has switched it on. Sanitised crashes.
  **report** — manual. The operator reads the payload and presses send; that is the consent.
               Available regardless of the background switch, unless the deployer has
               disabled outbound entirely, in which case mailto:/copy still works.

Since the maintainer's ingest was retired, BOTH channels are aimed at nothing unless a
deployer sets ``KP_TELEMETRY_DSN`` to a GlitchTip of their own. The route that actually
carries a bug report to us now is the manual one: the operator exports ``recent.py``'s
buffer and attaches it to a mail or a GitHub issue. A human is the transport, on purpose.

This package deliberately re-exports NOTHING. ``config.py`` reads the default DSN from
``dsn.py``, and a re-export here would pull ``consent.py`` — which imports ``config`` — into
that import and make the cycle. Import the submodule you need.
"""
