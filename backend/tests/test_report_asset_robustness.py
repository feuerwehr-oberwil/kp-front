"""A malformed asset reference must never crash report generation (SEC-06, 05.09.).

`_MEDIA_URL` used to match a loose 36 hex-or-dash characters and then hand the capture to
`uuid.UUID()`, which raised a ValueError on a matching-but-invalid string — surfacing as a 500
for everyone on the incident, and reachable with a low-trust capture/poster token. The pattern
is the canonical 8-4-4-4-12 UUID now, so a malformed media URL simply fails to match and is
skipped like a missing row.
"""

from app.api.report import _MEDIA_URL, ReportAssetScope, _check_asset_scope, resolve_report_assets
from app.report_pdf import ReportPayload

# 36 hex characters with no dashes: it matched the OLD `[0-9a-fA-F-]{36}` pattern, but
# `uuid.UUID("0"*36)` raises (a UUID is 32 hex digits, not 36).
BAD_MEDIA_URL = "/api/media/" + "0" * 36


def test_the_media_pattern_only_matches_a_real_uuid():
    import uuid

    assert _MEDIA_URL.match(BAD_MEDIA_URL) is None
    good = f"/api/media/{uuid.uuid4()}"
    m = _MEDIA_URL.match(good)
    assert m is not None
    uuid.UUID(m.group(1))  # never raises for anything the pattern accepts


def _payload(url: str, incident_id: str = "i") -> ReportPayload:
    return ReportPayload.model_validate(
        {
            "incident": {"title": "T", "id": incident_id},
            "generatedAt": "n",
            "journal": [{"timeLabel": "14:31", "area": "EL", "text": "x", "photoUrl": url}],
        }
    )


async def test_a_malformed_media_url_is_skipped_not_500(db_session):
    """The ordinary (scope=None) resolver path — used to call `uuid.UUID(bad)` and 500."""
    figs: dict[str, bytes] = {}
    await resolve_report_assets(db_session, _payload(BAD_MEDIA_URL), figs)
    assert f"photo:{BAD_MEDIA_URL}" not in figs  # simply not resolved, and nothing raised


async def test_a_malformed_media_url_does_not_500_the_scope_check(db_session):
    """The narrower capture/poster path runs the same reference through the scope check."""
    import uuid

    incident_id = uuid.uuid4()
    scope = ReportAssetScope(incident_id=incident_id, media_incident_ids=frozenset(), plan_dataset_ids=frozenset())
    await _check_asset_scope(db_session, _payload(BAD_MEDIA_URL, str(incident_id)), scope)  # must not raise
