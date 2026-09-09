"""The `sharepoint` config section: it survives a save, and it refuses what it cannot address.

The first test is the one that matters most. Every model in the config document is
`extra="ignore"`, so a section the schema does not DECLARE is silently dropped on the next
round-trip — a station would configure its folders, press save in /admin once, and find the
connector switched off with nothing said. That trap has bitten this document before.
"""

import pytest
from pydantic import ValidationError

from app.schemas import DeploymentConfigIn, SharePointConfig, load_stored_config

SITE = "https://feuerwehr.sharepoint.com/sites/kp"


def test_the_section_survives_the_round_trip_every_writer_performs():
    """Validate → dump → validate, which is what a PUT, an `admin_config load` and the workbook
    import all do to the whole document on every write."""
    document = {
        "sharepoint": {"intervalMinutes": 30, "sources": [{"area": "plans", "siteUrl": SITE, "path": "kp-data/plans"}]}
    }

    once = DeploymentConfigIn(**document).model_dump(mode="json")
    twice = load_stored_config(once).model_dump(mode="json")

    assert twice["sharepoint"]["intervalMinutes"] == 30
    assert twice["sharepoint"]["sources"] == [
        {"area": "plans", "siteUrl": SITE, "driveId": None, "library": None, "path": "kp-data/plans"}
    ]


def test_a_document_that_never_mentions_it_gets_an_empty_section_not_a_missing_one():
    assert DeploymentConfigIn().sharepoint.sources == []
    assert load_stored_config({}).sharepoint.intervalMinutes == 60


def test_every_area_is_independent_and_may_point_anywhere():
    """The amendment: no common root, no required layout — a station configures what it has."""
    config = SharePointConfig(
        sources=[
            {"area": "plans", "siteUrl": SITE, "path": "Kommando/Einsatzplaene"},
            {"area": "workbook", "driveId": "b!other-library", "path": ""},
        ]
    )
    assert [s.area for s in config.sources] == ["plans", "workbook"]
    assert config.sources[1].path == ""


@pytest.mark.parametrize(
    ("source", "because"),
    [
        ({"area": "plans"}, "neither siteUrl nor driveId"),
        ({"area": "plans", "siteUrl": SITE, "driveId": "b!x"}, "both at once is ambiguous"),
        ({"area": "plans", "siteUrl": "http://feuerwehr.example"}, "plain http"),
        ({"area": "plans", "siteUrl": SITE, "path": "../../andere-abteilung"}, "a way out of the library"),
        ({"area": "plans", "siteUrl": SITE, "path": "x" * 500}, "longer than the cap"),
        ({"area": "gemeindeplan", "siteUrl": SITE}, "not an area this connector imports"),
    ],
)
def test_an_unaddressable_source_is_refused_where_it_is_typed(source, because):
    with pytest.raises(ValidationError):
        SharePointConfig(sources=[source])


def test_a_path_is_stored_without_its_slashes_so_two_spellings_are_one_folder():
    config = SharePointConfig(sources=[{"area": "geodata", "siteUrl": SITE, "path": "/gis/layer/"}])
    assert config.sources[0].path == "gis/layer"


def test_one_folder_per_area():
    """Two half-listings for one area cannot be told from one broken listing, and the
    refuse-to-empty guard reads a listing as the complete statement of what the area holds."""
    with pytest.raises(ValidationError, match="configured twice"):
        SharePointConfig(
            sources=[
                {"area": "plans", "siteUrl": SITE, "path": "a"},
                {"area": "plans", "siteUrl": SITE, "path": "b"},
            ]
        )


def test_the_section_is_in_the_schema_the_cli_prints():
    """`admin_config schema` is the contract a station authors against — it is generated from
    this model, so declaring the section is all it takes for the CLI to cover it."""
    schema = DeploymentConfigIn.model_json_schema()
    assert "sharepoint" in schema["properties"]
    assert "SharePointSource" in schema["$defs"]
