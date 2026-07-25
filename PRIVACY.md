# Privacy

KP Front is self-hosted. Your incident data, your roster, your map cache and your media live on
**your** server and are never transmitted anywhere by this software. There is no cloud account,
no licence check, no usage beacon, and no "phone home" on start-up.

This document covers the one exception: the two channels through which a station can *choose* to
send something to the maintainer. Both are off or manual by default. If you never touch them,
nothing about your installation ever reaches us — you can verify that with `tcpdump`, and
several of the tests in this repository exist to prove it stays true.

## The short version

| | Manual report | Background error reports |
| --- | --- | --- |
| Who starts it | An operator, by pressing **Senden** | The app, after a crash |
| Default | Always available | **Off** |
| Consent | Pressing the button | An admin switches it on in **System & Wartung** |
| Can be disabled entirely | Yes, `KP_TELEMETRY_ENABLED=0` | Yes, same switch |
| Content | The text they typed, plus the technical block they read first | A sanitised crash |

## What is sent

Both channels send the same **context block** and nothing else besides it:

| Field | Example | Why |
| --- | --- | --- |
| `install` | `9f1c…` (random UUID) | So two reports from the same station are recognisably the same station |
| `app` | `kp-front` | Which of the two apps |
| `release` | `0.2.0+a1b2c3d` | The single most useful field in any bug report |
| `device` | `iPad Safari` | A rendering bug is usually a browser bug |
| `viewport` | `1024×768` | A layout bug is a viewport bug |
| `locale` | `de-CH` | Which copy catalogue was active |
| `online` | `true` | Whether the tablet had a connection |

A manual report adds the operator's own text and which trouble prompted it. A background error
report adds the exception type, a scrubbed message, a stack reduced to function names and module
basenames, and the route shape.

## What is never sent

Not "we try not to send" — these are constructed out of the payload and asserted by tests
(`backend/tests/test_telemetry_scrub.py`):

- **Incident data of any kind**: addresses, coordinates (WGS84 *and* LV95), incident IDs, object
  names, journal text, drawings, photos, audio, plan files.
- **People**: roster names, functions, phone numbers, e-mail addresses, Divera identities, PINs.
- **Your instance**: hostname, station name, deployment config, database contents, file paths,
  usernames, environment variables, tokens, secrets.
- **Network identity**: no IP address is placed in the payload, and no `user` object exists for
  one to appear in later. See "The IP question" below for the part we cannot solve in code.
- **Screenshots.** There is no code path that captures one.

The payload is built by an **allow-list**: every field is named in
`backend/app/telemetry/scrub.py` and the caller's object is never forwarded, merged or spread.
A field nobody wrote a line of code for cannot leak. Free text is additionally scrubbed, because
the value is often *inside* the message — `TypeError … at Hauptstrasse 12` is a real shape.

## How to check, rather than trust

You do not have to take any of the above on faith:

1. **Your own log.** Every payload is written to your server's log in full, at `INFO`, *before*
   it is sent. Look for `telemetry: queuing … exact content follows`.
2. **Your own database.** The same payload stays verbatim in the `telemetry_outbox` table.
   `SELECT payload_json FROM telemetry_outbox;` is the whole story, before and after delivery.
3. **The admin screen.** *System & Wartung → Fehlerberichte* shows the same rows, newest first,
   as formatted JSON.
4. **The manual report** shows you the technical block before you send, and — after sending —
   what the server says it actually queued.

## Where it goes

To a GlitchTip instance run by the maintainer. GlitchTip is an open-source, Sentry-compatible
error tracker; it runs on a host that is network-isolated from anything else of ours.

The credential embedded in this repository (`backend/app/telemetry/dsn.py`) is a Sentry **public
key**. It is write-only by construction: it can submit an event and nothing else — it cannot
read stored events, cannot reach another project, and cannot log in. It is checked in in the
clear deliberately, so that anyone auditing this repository finds it and can satisfy themselves
in thirty seconds that it does not read their data.

**Retention:** reports are kept for 90 days and then deleted. Delivered rows in your own outbox
are swept after 14 days (yours to change).

## Your choices

- **Never send anything.** Do nothing. This is the default state of a fresh install and of every
  instance that upgrades into this version.
- **Enforce it centrally.** Set `KP_TELEMETRY_ENABLED=0` in your compose file. This outranks the
  admin switch, so no later click can turn it on.
- **Point it at yourself.** Set `KP_TELEMETRY_DSN` to your own GlitchTip and the same machinery
  reports to *your* server. We never hear from you.
- **Unlink your history.** *System & Wartung → Neue Kennung* mints a fresh install UUID. Reports
  we already hold keep the old one and can no longer be connected to anything you send after.
- **Ask for deletion.** Mail the install UUID to bastian@eichenbergers.ch and everything under
  it is deleted. You do not have to explain why.

## The IP question

Your server's IP address is visible to our ingest host, the same way it is visible to any server
you make a request to. We do not put it in the payload and GlitchTip is configured not to store
it. We cannot prove that second claim to you from inside this repository, which is exactly why
`KP_TELEMETRY_ENABLED=0` exists and why the default is off. If your threat model includes the
maintainer's own infrastructure, do not switch this on — that is a legitimate position and the
app is fully functional without it.

## Legal

Your fire service is the data controller for everything in its instance. Switching on background
error reports makes the maintainer a recipient of the (sanitised, non-personal) data described
above. That decision belongs to the organisation, which is why the switch lives behind
`ADMIN_SECRET` and not in the operator's settings sheet — and why nothing is enabled by an
upgrade.

Questions, or a deletion request: **bastian@eichenbergers.ch**.
