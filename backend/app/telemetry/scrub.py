"""Sanitisation — the only thing standing between an Einsatz and a stranger's server.

Two rules, and the second one is the one that actually holds:

1. **Allow-list, never deny-list.** Every payload that leaves this instance is CONSTRUCTED
   here from named fields. The caller's object is never forwarded, never merged, never
   `**spread` into the result. A field that nobody wrote a line of code for cannot leak,
   which is a property a deny-list can never give you — the next person to add
   `incident.address` to an error context does not have to remember this module exists.

2. **Free text still gets scrubbed.** The one field we cannot allow-list is the sentence a
   human typed and the message inside an exception. `TypeError: Cannot read 'name' of
   undefined at Hauptstrasse 12` is a real shape of leak: the value is IN the message.
   So every string that survives rule 1 goes through :func:`scrub_text` as well.

This module is deliberately dependency-free and pure — no DB, no HTTP, no app imports — so
it can be vendored into kp-rueck byte-for-byte and tested without a stack. See
``tests/test_telemetry_scrub.py``; the drift test keeps the two copies identical.
"""

from __future__ import annotations

import re

# --- What must never leave, restated on this side of the wire ------------------------
#
# The frontend's src/lib/feedbackReport.ts carries the same list and asserts it in its own
# tests. Keeping both is not redundancy: that one guards what the UI puts in front of the
# operator, this one guards what the server puts on the wire, and they are edited by
# different changes. If you are here to add a field, the question is not "is it useful for
# debugging" but "could it identify an Einsatz, an address, or a person".
NEVER_INCLUDED = (
    "incidentId",
    "address",
    "lat",
    "lng",
    "personnel",
    "screenshot",
    "workspace",
    "userAgent",  # server-side we are stricter than the UI: the raw UA is a fingerprint
)

# Replacement marker. Short, obvious in a stack trace, and impossible to mistake for data.
REDACTED = "‹entfernt›"

# --- Free-text scrubbing --------------------------------------------------------------
#
# Ordering matters and is load-bearing. Paths run before URLs (a file:// URL is a path),
# tokens run before generic key=value, and coordinates run before bare numbers. Each rule
# is anchored tightly enough that it cannot eat a whole line: an over-eager scrubber that
# turns every message into ‹entfernt› is a scrubber that gets switched off.

_RULES: tuple[tuple[re.Pattern[str], str], ...] = (
    # Secrets first — a leaked token is the only item here that is actively dangerous.
    (
        re.compile(r"\b(bearer|token|secret|apikey|api_key|password|pin)\b\s*[:=]?\s*\S+", re.I),
        rf"\1 {REDACTED}",
    ),
    # JWTs are recognisable on their own, with or without a label.
    (re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+"), REDACTED),
    # Query strings: the values are the risk (?token=, ?address=), the path is the signal.
    (re.compile(r"\?[^\s\"']{1,400}"), "?…"),
    # Absolute paths → basename. Keeps the useful half of a stack frame, drops the
    # username and the directory layout of someone else's server.
    (re.compile(r"(?:file://)?(?:/[\w.\-@ ]+){2,}/([\w.\-]+)"), r"…/\1"),
    (re.compile(r"[A-Za-z]:\\(?:[\w.\-@ ]+\\){1,}([\w.\-]+)"), r"…\\\1"),
    # http(s) origins in stack frames / messages → scheme + path shape, no host.
    (re.compile(r"https?://[^\s/\"']+"), "https://…"),
    (re.compile(r"[\w.+-]+@[\w-]+\.[\w.]{2,}"), REDACTED),
    # Swiss phone shapes: +41 79 123 45 67, 0041…, 079 123 45 67, with any separators.
    (re.compile(r"(?:\+41|0041|\b0)\s?\d{2}[\s./-]?\d{3}[\s./-]?\d{2}[\s./-]?\d{2}\b"), REDACTED),
    (re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"), REDACTED),  # IPv4
    (re.compile(r"\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b", re.I), REDACTED),  # IPv6
    (re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.I), REDACTED),
    # WGS84 decimal pair — anything with 4+ decimals next to a comma is a position, and a
    # position in this app is an Einsatzort.
    (re.compile(r"\b\d{1,3}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}\b"), REDACTED),
    # LV95 pair (E 2.6M / N 1.2M) — the projected form of the same thing.
    (re.compile(r"\b2[0-9]{6}(?:\.\d+)?\s*[,/]\s*1[0-9]{6}(?:\.\d+)?\b"), REDACTED),
    # Swiss street + house number. Deliberately narrow: only the -strasse/-gasse/-weg/…
    # suffixes, and only when a number follows, because that is the shape an address takes
    # when it reaches a log line. "Strassenzustand" alone is not an address and stays.
    (
        re.compile(
            r"\b[A-ZÄÖÜ][\w.\-]*(?:strasse|straße|gasse|weg|platz|ring|allee|matte|halde|rain)"
            r"\s+\d+[a-z]?\b",
            re.I,
        ),
        REDACTED,
    ),
)

# Hard ceiling per string. A runaway message must not become the payload; the ingest side
# rate-limits by request, not by byte, so the cap belongs here.
MAX_TEXT = 2000


def scrub_text(value: str | None, *, limit: int = MAX_TEXT) -> str:
    """Run one free-text string through every rule. Never raises, never returns None.

    Idempotent by construction — running it twice is a no-op, which matters because the
    manual-report path scrubs on the way in (so the operator sees what we stored) and the
    forwarder scrubs again on the way out (so a later code path cannot bypass it).
    """
    if not value:
        return ""
    out = str(value)[: limit * 2]  # bound the regex work before bounding the result
    for pattern, replacement in _RULES:
        try:
            out = pattern.sub(replacement, out)
        except Exception:  # noqa: BLE001 — a scrubber that raises would fail OPEN upstream
            return REDACTED
    return out[:limit].strip()


def scrub_stack(stack: str | None, *, max_frames: int = 30) -> str:
    """Stack traces: keep the shape, drop the filesystem.

    A frame is worth keeping for its function name and its module BASENAME. The absolute
    path tells us the deployer's username and directory layout and nothing about the bug —
    :func:`scrub_text` already reduces it, this just also bounds the frame count so a deep
    recursion doesn't ship 8 kB of the same line.
    """
    if not stack:
        return ""
    lines = [scrub_text(line, limit=300) for line in str(stack).splitlines()[:max_frames]]
    return "\n".join(line for line in lines if line)


# --- Allow-list construction ----------------------------------------------------------


def _version_only(build: str | None) -> str:
    """`v0.2.0+a1b2c3d` → `v0.2.0+a1b2c3d`, but bounded and stripped of anything else.

    The build stamp is the single most useful field in a bug report and carries no personal
    data, so it passes through — length-capped like everything else.
    """
    if not build:
        return "unknown"
    return re.sub(r"[^\w.+\-]", "", str(build))[:60] or "unknown"


def _device_class(user_agent: str | None) -> str:
    """Raw UA → a coarse bucket.

    The full UA string is a fingerprint (patch versions, device model, sometimes the
    station's MDM build) and would let us tell two installs apart even without the UUID.
    What actually helps a rendering bug is "iPad Safari" vs "Android Chrome", so that is
    all we send. This is stricter than the UI's technical block on purpose: the operator
    may see their own UA, we may not keep it.
    """
    ua = (user_agent or "").lower()
    if not ua:
        return "unknown"
    if "ipad" in ua or ("macintosh" in ua and "mobile" in ua):
        platform = "iPad"
    elif "iphone" in ua:
        platform = "iPhone"
    elif "android" in ua:
        platform = "Android"
    elif "windows" in ua:
        platform = "Windows"
    elif "macintosh" in ua or "mac os" in ua:
        platform = "macOS"
    elif "linux" in ua:
        platform = "Linux"
    else:
        platform = "other"
    if "firefox" in ua:
        browser = "Firefox"
    elif "edg/" in ua:
        browser = "Edge"
    elif "chrome" in ua or "crios" in ua:
        browser = "Chrome"
    elif "safari" in ua:
        browser = "Safari"
    else:
        browser = "other"
    return f"{platform} {browser}"


def _viewport_bucket(viewport: str | None) -> str:
    """`1024×768` → `1024×768`, but only if it parses as two plausible integers.

    Kept because a layout bug is a viewport bug; harmless because millions of devices share
    a resolution. Anything unparseable is dropped rather than passed through.
    """
    if not viewport:
        return ""
    m = re.match(r"^\s*(\d{2,5})\s*[x×]\s*(\d{2,5})\s*$", str(viewport))
    return f"{m.group(1)}×{m.group(2)}" if m else ""


def build_context(
    *,
    install_id: str,
    app: str,
    release: str,
    user_agent: str | None = None,
    viewport: str | None = None,
    locale: str | None = None,
    online: bool | None = None,
) -> dict:
    """The context block shared by both channels. Constructed field by field — rule 1.

    ``install_id`` is a random UUID minted once per instance. It exists so two reports from
    the same station are recognisably the same station, and for nothing else: it is not
    derived from the hostname, the config, the roster or the DB, so it cannot be reversed
    into an identity. An operator can regenerate it in the admin UI, which is also how a
    deletion request is honoured (see PRIVACY.md).
    """
    ctx = {
        "install": install_id,
        "app": app,
        "release": _version_only(release),
        "device": _device_class(user_agent),
    }
    if vp := _viewport_bucket(viewport):
        ctx["viewport"] = vp
    if locale:
        # Language tag only: de-CH is not identifying, a full Accept-Language header is.
        ctx["locale"] = re.sub(r"[^\w-]", "", str(locale))[:12]
    if online is not None:
        ctx["online"] = bool(online)
    return ctx


def build_error(
    *,
    kind: str,
    message: str | None,
    stack: str | None = None,
    component_stack: str | None = None,
    path: str | None = None,
) -> dict:
    """A sanitised crash. Every field is either an enum, a bounded token, or scrubbed text."""
    return {
        # Enum, not free text — an unknown kind becomes "error" rather than travelling.
        "kind": kind if kind in {"render", "error", "unhandledrejection"} else "error",
        "message": scrub_text(message),
        "stack": scrub_stack(stack),
        "componentStack": scrub_stack(component_stack, max_frames=15),
        # Route shape only: /incident/<uuid> → /incident/‹entfernt› via the UUID rule.
        "path": scrub_text(path, limit=200),
    }


def build_report(*, message: str, trouble_kind: str | None, trouble_at: str | None) -> dict:
    """The manual channel: the operator's own words, scrubbed, plus which trouble prompted it.

    The words are the entire point of this channel — a log can produce the stack trace, only
    a human can produce «ich hab den Trupp gerade auf Rückweg gesetzt, dann war der Bildschirm
    weg». We scrub them anyway, because a helpful operator will type the address.
    """
    return {
        "message": scrub_text(message),
        "trouble": trouble_kind
        if trouble_kind in {"crashLoop", "crash", "storageFull", "syncConflict"}
        else None,
        "troubleAt": scrub_text(trouble_at, limit=40) or None,
    }
