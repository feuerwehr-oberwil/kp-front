"""Opt-in, sanitised telemetry for a self-hosted app.

Read in this order:

* ``dsn.py``       — why a credential is checked in, and what it can't do
* ``scrub.py``     — the allow-list; the only place a field can be added to a payload
* ``envelope.py``  — the wire format, hand-written instead of an SDK, and why
* ``consent.py``   — who is allowed to decide, and what NULL means
* ``outbox.py``    — the queue, and the transparency log
* ``forwarder.py`` — the one place that opens a connection to us

Two channels, and the difference between them is the difference the whole design rests on:

  **error**  — background. Off unless an admin has switched it on. Sanitised crashes.
  **report** — manual. The operator reads the payload and presses send; that is the consent.
               Available regardless of the background switch, unless the deployer has
               disabled outbound entirely, in which case mailto:/copy still works.

This package deliberately re-exports NOTHING. ``config.py`` reads the default DSN from
``dsn.py``, and a re-export here would pull ``consent.py`` — which imports ``config`` — into
that import and make the cycle. Import the submodule you need.
"""
