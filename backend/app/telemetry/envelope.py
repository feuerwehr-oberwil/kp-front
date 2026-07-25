"""Sentry envelope serialisation — ~80 lines instead of an SDK, and that is the feature.

The obvious move here is ``sentry_sdk``. We don't use it, for one reason that outweighs
everything the SDK gives us: its value is auto-instrumentation, and auto-instrumentation is
exactly what must not happen in this app. The SDK's defaults capture breadcrumbs from every
outgoing request (URLs with incident ids in them), from console output, from DOM clicks, and
attach the client IP as ``user.ip_address``. Adopting it would mean turning those off one by
one in ``before_send`` and hoping the next SDK release doesn't add a source we forgot — a
deny-list, maintained forever, against an upstream that has every incentive to collect more.

Writing the envelope by hand inverts that: the payload contains what this file puts in it.
The format is a documented three-line POST body and has been stable for years. The cost is
this module; the benefit is that "what does this app send" is answerable by reading one
screen of code, which is the only answer that means anything to a fire station.

Envelope layout (newline-delimited JSON):

    {"event_id":…,"sent_at":…}      ← envelope header
    {"type":"event","length":N}     ← item header
    {…the event…}                   ← item payload
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime

# Marks every event as coming from a self-hosted install rather than our own demo/prod.
# Deliberately NOT the deployment's own name: "which station is this" is what the random
# install id answers, and it answers it without naming anyone.
ENVIRONMENT = "self-hosted"


def _now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def _split_exception(message: str) -> tuple[str, str]:
    """`TypeError: Cannot read 'x' of undefined` → (`TypeError`, `Cannot read …`).

    Sentry groups by exception type + the top stack frame, so handing it a type instead of
    one long string is the difference between "47 occurrences of one bug" and 47 separate
    issues. Anything that doesn't look like `Type: message` is reported as `Error`.
    """
    head, sep, tail = message.partition(": ")
    if sep and head and " " not in head and len(head) <= 60:
        return head, tail
    return "Error", message


def build_event(
    *,
    channel: str,
    context: dict,
    error: dict | None = None,
    report: dict | None = None,
) -> dict:
    """Assemble the event body from ALREADY-SANITISED parts.

    This function does no scrubbing of its own — by the time anything reaches here it has
    been through scrub.py, and re-scrubbing at the last moment would just hide the fact that
    some caller forgot to. The forwarder asserts that ordering instead.
    """
    install = context.get("install", "unknown")
    event: dict = {
        "event_id": uuid.uuid4().hex,
        "timestamp": _now_iso(),
        "platform": "javascript",
        "environment": ENVIRONMENT,
        "release": f"{context.get('app', 'kp')}@{context.get('release', 'unknown')}",
        # Tags are the searchable axes on the ingest side. All four are coarse buckets or
        # the random install id — none of them narrows to a person.
        "tags": {
            "channel": channel,
            "install": install,
            "device": context.get("device", "unknown"),
            "app": context.get("app", "kp"),
            **({"locale": context["locale"]} if context.get("locale") else {}),
            **({"kind": error["kind"]} if error else {}),
            **({"trouble": report["trouble"]} if report and report.get("trouble") else {}),
        },
        # `contexts.instance` rather than `user`: Sentry's `user` object is where the SDKs
        # put an IP address and an account, and we want neither field to exist at all.
        "contexts": {
            "instance": {
                "type": "instance",
                "install": install,
                **({"viewport": context["viewport"]} if context.get("viewport") else {}),
                **({"online": context["online"]} if "online" in context else {}),
            }
        },
    }

    if error:
        etype, evalue = _split_exception(error.get("message") or "unknown")
        event["level"] = "error"
        event["exception"] = {"values": [{"type": etype, "value": evalue}]}
        # Stacks travel as plain text in `extra`, not as a parsed `stacktrace`: the parsed
        # form has a `filename`/`abs_path` per frame, and a half-populated one invites
        # someone to "fix" it later by putting the real paths back.
        extra = {k: error[k] for k in ("stack", "componentStack", "path") if error.get(k)}
        if extra:
            event["extra"] = extra
    elif report:
        event["level"] = "info"
        event["message"] = {"formatted": report.get("message") or "(ohne Beschreibung)"}
        if report.get("troubleAt"):
            event["extra"] = {"troubleAt": report["troubleAt"]}
    else:  # pragma: no cover — build_event is never called without a body
        event["level"] = "info"
        event["message"] = {"formatted": "(leer)"}

    return event


def serialise_envelope(event: dict) -> bytes:
    """Wrap one event in the envelope frame. Bytes, because `length` is a BYTE count."""
    body = json.dumps(event, separators=(",", ":"), ensure_ascii=False).encode()
    header = json.dumps(
        {"event_id": event["event_id"], "sent_at": _now_iso()}, separators=(",", ":")
    ).encode()
    item = json.dumps({"type": "event", "length": len(body)}, separators=(",", ":")).encode()
    return b"\n".join((header, item, body)) + b"\n"
