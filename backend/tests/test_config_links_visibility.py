"""Who may read `report.links` off `GET /api/config`.

The endpoint is deliberately public — the login screen needs the station's branding before
anybody has signed in. `report.links` is the one part of that document which must not be:
those URLs are CAPABILITIES. A Google-Forms prefill link is submittable by whoever holds it,
and the list also names a Wehr's internal paperwork and the hosts it lives on. The Rapport is
the only surface that shows them and it sits behind the PIN, so «anyone who can reach the login
screen» is the wrong audience.

⚠️ The admin must keep receiving them. Verwaltung saves with a FULL-DOCUMENT PUT (GET → draft →
PUT), so a section an admin never received is a section the next unrelated edit deletes — the
same trap `alarmKeywords` carries its own warning about.
"""

from app.api.config import _projection
from app.schemas import DeploymentConfigIn

LINKS = [{"id": "getraenke", "title": "Getränke", "url": "https://forms.example.ch/f"}]


def _doc() -> DeploymentConfigIn:
    return DeploymentConfigIn.model_validate({"report": {"partnerOrgs": ["Polizei"], "links": LINKS}})


def test_an_anonymous_caller_gets_no_urls():
    report = _projection(_doc(), include_keywords=False, include_links=False).model_dump()["report"]
    assert report["links"] == []
    # …and the rest of the section is untouched: this withholds one field, it does not blank the
    # block the paper Erfassungsblatt is built from
    assert report["partnerOrgs"] == ["Polizei"]


def test_a_signed_in_session_gets_them_because_the_rapport_needs_them():
    report = _projection(_doc(), include_keywords=False, include_links=True).model_dump()["report"]
    assert [row["id"] for row in report["links"]] == ["getraenke"]


def test_an_admin_gets_them_or_the_next_save_would_delete_them():
    report = _projection(_doc(), include_keywords=True, include_links=True).model_dump()["report"]
    assert len(report["links"]) == 1, "Verwaltung round-trips the whole document on save"


def test_the_withholding_does_not_announce_itself():
    """A station WITH forms, seen anonymously, must be byte-identical to a station without —
    otherwise the response itself says «there is something here you are not being shown»."""
    none_configured = DeploymentConfigIn.model_validate({"report": {"partnerOrgs": ["Polizei"]}})
    hidden = _projection(_doc(), include_keywords=False, include_links=False).model_dump()
    empty = _projection(none_configured, include_keywords=False, include_links=False).model_dump()
    assert hidden == empty
