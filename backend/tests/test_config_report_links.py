"""`report.links` — the station's own forms as a tick-off list on the Rapport.

Verwaltung saves the config with a FULL-DOCUMENT PUT, which is what makes the shape of this
field load-bearing: a value the model refuses is not a refused edit, it is a document that
cannot be saved at all until the tab is reloaded. These tests pin the two ends of that.
"""

import pytest
from pydantic import ValidationError

from app.schemas import DeploymentConfigIn


def test_a_station_with_no_forms_says_so_with_an_empty_list():
    """⚠️ The editor deleting its last row must send `[]`, never `null`.

    `links` is a plain `list[...]`, so `None` is a validation error — and because the whole
    document goes up in one PUT, that 422 also refuses every unrelated Station edit sitting in
    the same draft, in an autosave retry loop. Unset and empty both mean «no section».
    """
    assert DeploymentConfigIn.model_validate({"report": {}}).report.links == []
    assert DeploymentConfigIn.model_validate({"report": {"links": []}}).report.links == []
    with pytest.raises(ValidationError):
        DeploymentConfigIn.model_validate({"report": {"links": None}})


def test_a_configured_form_survives_a_save_with_its_placeholders_intact():
    """`extra="ignore"` is the trap this file's sibling test exists for: a field the model does
    not declare is dropped silently, so a station's link would come back without its prefill."""
    url = "https://forms.example.ch/f?entry.111111111={einsatzleiter}&entry.222222222=Einsatz {datum}"
    cfg = DeploymentConfigIn.model_validate(
        {
            "report": {"links": [{"id": "getraenke", "title": "Getränke", "url": url, "note": "nur bei Bezug"}]},
        }
    )
    row = cfg.report.links[0]
    assert (row.id, row.title, row.note) == ("getraenke", "Getränke", "nur bei Bezug")
    assert row.url == url, "the {platzhalter} tokens are resolved in the app, never here"


@pytest.mark.parametrize(
    ("bad", "why"),
    [
        ({"id": "", "title": "T", "url": "https://x.ch"}, "no id — the tick state has nothing to hang on"),
        ({"id": "a", "title": " ", "url": "https://x.ch"}, "blank title — a row nobody could read"),
        ({"id": "a", "title": "T", "url": "javascript:alert(1)"}, "not a page this app will open"),
        ({"id": "a", "title": "T", "url": "/relativ"}, "no scheme"),
    ],
)
def test_a_row_the_rapport_would_drop_is_refused_here_instead(bad: dict, why: str):
    """A row the app filters out is worse than a rejected one: it is saved, shown as configured
    in Verwaltung, and simply never appears. The scheme check is also defence in depth — the
    frontend gate protects the one consumer that exists today, not the next one.
    """
    with pytest.raises(ValidationError, match=r"links"):
        DeploymentConfigIn.model_validate({"report": {"links": [bad]}})


def test_the_url_is_stored_trimmed():
    """Copy-pasting a prefill link out of Google Forms brings whitespace with it."""
    cfg = DeploymentConfigIn.model_validate(
        {
            "report": {"links": [{"id": "a", "title": "T", "url": "  https://x.ch/f  "}]},
        }
    )
    assert cfg.report.links[0].url == "https://x.ch/f"
