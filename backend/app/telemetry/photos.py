"""The one part of a payload the scrubber cannot read: a photo the operator picked by hand.

Everything else that leaves this instance is CONSTRUCTED from named fields (``scrub.py``,
rule 1), and every free-text string that survives that is additionally rewritten by the
scrubber (rule 2). A JPEG obeys neither. There is no allow-list for pixels, and no regex that
can tell a Magazintor from an Einsatzort. So this module cannot inherit the guarantee the rest
of the package rests on, and it does not pretend to.

What it inherits instead is the older and stronger rule — *nothing leaves without a human
deciding* — applied one notch harder than anywhere else in here:

* the operator picks the file themselves; there is no code path in this app that captures a
  screen, and adding one would defeat the point of this one,
* the sheet renders the picture as a thumbnail next to the technical block, ABOVE the send
  button, so it is read the same way the JSON below it is read,
* it rides the direct-send route only. Kopieren and E-Mail cannot carry a binary, and the
  direct route is also the one that answers with what the server queued.

Not vendored, deliberately. ``tests/test_telemetry_vendored.py`` pins the four files that decide
what a payload *contains* to a checksum shared with kp-rueck; this one sits beside them because
kp-rueck has no Rückmeldung photo to carry and should not grow the code for one.

TRANSPORT — base64 inside the event, not a Sentry attachment item
=================================================================
The envelope format has an item type made for exactly this job, and we do not use it. Two
reasons, either of which is on its own decisive:

* ``envelope.py`` and ``forwarder.py`` are vendored byte-for-byte into kp-rueck and pinned by
  the drift test. Emitting an attachment item means editing both, and that test's own rule is
  that such a change lands in BOTH repositories together — which a change confined to this one
  cannot do, and half of it would leave the other app's CI red for a feature it does not have.
* the ingest is GlitchTip (see ``deploy/ingest/``), which does not implement attachment items.
  It would answer 200 and keep nothing. A transport whose failure mode is "the receiver says
  yes and stores nothing" is worse than a bigger event, because nobody finds out.

Base64 in the event body also keeps the property this whole package is defended with: the
outbox logs the payload verbatim before queueing it and stores it verbatim afterwards, so what
a station can read in its own log and in ``telemetry_outbox`` is the entire thing that left,
picture included. An attachment parked next to the row would have been the first payload the
transparency log could not show. The honest cost is that a manual report with a photo now
writes ~1 MB into that log instead of ten lines — rare, since a human has to choose it twice,
and preferable to a payload the deployer cannot see.

The price of base64 is arithmetic, which is why the cap below is hard rather than generous.
"""

from __future__ import annotations

import base64
import binascii
import logging
from collections.abc import Sequence

logger = logging.getLogger("kp.telemetry")

# Two, because a Rückmeldung is «was ist passiert», not an album: one picture of the screen and
# one of the thing next to it is the whole realistic case, and a third is someone using the
# wrong tool.
MAX_PHOTOS = 2

# Bytes per photo, AFTER the browser has downscaled it (src/lib/imagePrep.ts ·
# prepareFeedbackPhoto targets the same number and gives up rather than exceed it). The
# arithmetic, because a cap without one is a guess dressed as a limit:
#
#   · base64 costs 4/3, so MAX_PHOTOS photos at this cap are ~960 kB of event body;
#   · a Sentry-compatible ingest accepts one event item up to 1 MB, and KP_TELEMETRY_DSN is
#     overridable to a real Sentry, so the documented limit is the one to respect rather than
#     whatever GlitchTip currently happens to tolerate;
#   · the rest of the event is a few hundred bytes.
#
# 360 kB is what is left. That is ~1600 px of JPEG at q 0.6 — enough to see which button was on
# screen and what the map looked like, which is the entire job. It is well below the ~1.5 MB a
# single downscaled tablet photo could still be, and that is the point: the cap is set by what
# the wire can deliver, not by what a camera produces.
MAX_PHOTO_BYTES = 360_000

# The same ceiling expressed for the request model, so an oversized string is refused by
# validation before anything decodes it.
MAX_PHOTO_B64_CHARS = (MAX_PHOTO_BYTES + 2) // 3 * 4

# Sniffed from the bytes, never from a client-supplied content type: the mime we forward has to
# describe what is actually there. Anything else is dropped rather than relabelled.
_MAGIC: tuple[tuple[bytes, str], ...] = (
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"\x89PNG\r\n\x1a\n", "image/png"),
)


def _sniff(data: bytes) -> str | None:
    for prefix, mime in _MAGIC:
        if data.startswith(prefix):
            return mime
    # RIFF….WEBP — the only container here whose marker is not at offset 0.
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def prepare_photos(raw: Sequence[str]) -> list[dict]:
    """Validate base64 photos and return the items to put on the wire.

    Drops anything that does not decode, is not a picture, or is over the cap, and says so in
    the log. It does not raise: this endpoint's contract is that it never fails for the wrong
    reason, and a malformed attachment must not cost the operator the sentences they typed.
    A dropped photo is not silent either — the echo the sheet renders reports how many were
    actually queued, so «ich hab zwei angehängt» and «eins liegt hier» are visibly different.
    """
    out: list[dict] = []
    for i, item in enumerate(raw[:MAX_PHOTOS]):
        try:
            data = base64.b64decode(item, validate=True)
        except (binascii.Error, ValueError):
            logger.warning("telemetry: report photo %d is not valid base64, dropped", i)
            continue
        if not data or len(data) > MAX_PHOTO_BYTES:
            logger.warning("telemetry: report photo %d is %d bytes (cap %d), dropped", i, len(data), MAX_PHOTO_BYTES)
            continue
        mime = _sniff(data)
        if mime is None:
            logger.warning("telemetry: report photo %d is not a jpeg/png/webp, dropped", i)
            continue
        # Re-encoded from the decoded bytes rather than passed through: what we forward is then
        # canonical base64 of exactly what we measured, not whatever whitespace, data: prefix or
        # padding variant the client happened to send.
        out.append({"mime": mime, "bytes": len(data), "data": base64.b64encode(data).decode()})
    return out


def attach(event: dict, photos: list[dict]) -> None:
    """Put prepared photos into an ALREADY-BUILT event, in place.

    Here rather than in ``envelope.build_event`` for the reason at the top of this file — that
    function is vendored — but the separation is also the honest shape: ``build_event`` assembles
    a payload every field of which came through the allow-list, and this adds the one field that
    did not. Keeping that addition in one visible call is worth more than a tidier signature.

    No-op without photos, so a report that carries none is byte-identical to one from before
    this feature existed.
    """
    if not photos:
        return
    event.setdefault("extra", {})["photos"] = photos
    # A count, not a filename or a size — the tag is a searchable axis on the ingest side, and
    # "this report came with a picture" is the only thing about it worth searching for.
    event.setdefault("tags", {})["photos"] = str(len(photos))


def summarise_for_echo(event: dict) -> dict:
    """The event as the sheet should render it: every photo's base64 replaced by its size.

    This is the one place the echo is deliberately not a byte-for-byte repeat of what was
    queued, and it is worth being explicit about why. The echo exists so the operator can check
    that the client-side preview was honest — a preview written by the sender is a promise, one
    returned by the receiver is a check. For a picture that check has already happened, visually,
    in the thumbnail they were looking at when they pressed send. Repeating 900 kB of base64 into
    a ``<pre>`` would bury the answer to the question the screen is actually asking («ist es
    angekommen»), and the full bytes are still verbatim in the deployer's log and in
    ``telemetry_outbox``, which is where an audit belongs anyway.

    Returns the event unchanged when there is nothing to summarise, and never mutates it.
    """
    photos = event.get("extra", {}).get("photos")
    if not photos:
        return event
    summarised = [{k: v for k, v in p.items() if k != "data"} for p in photos]
    return {**event, "extra": {**event["extra"], "photos": summarised}}
