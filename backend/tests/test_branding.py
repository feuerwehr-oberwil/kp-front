"""Branding slots — the contract between the upload API and the config projection."""

from app.api.branding import _SLOTS
from app.schemas import IdentityAssets


def test_every_uploadable_slot_survives_the_config_projection():
    """⚠️ `IdentityAssets` sets `extra="ignore"`, so a slot the API accepts but the schema does
    not NAME is stored and then silently dropped on the way back out: the upload returns 200,
    the blob is written, and the URL is simply gone from `GET /api/config`.

    That is exactly how `reportLogo` shipped unnoticed — the demo reset installed it every night
    and the deployment served a config without it, so the rapport printed no logo and nothing
    anywhere said why.
    """
    missing = [s for s in _SLOTS if s not in IdentityAssets.model_fields]
    assert not missing, f"uploadable but absent from the projection (will vanish silently): {missing}"
