"""The `setup` config section: the hand ticks on the «Einrichtung» card survive a save.

Same trap as `sharepoint`, same reason it gets its own file. Every model in the config document
is `extra="ignore"`, so a section the schema does not DECLARE is dropped on the next round-trip
without a word. Here that would read as a checklist row that ticks, looks done, and is open
again after a reload — the one bug this feature exists to fix, wearing a different hat.
"""

from app.schemas import DeploymentConfigIn, SetupConfig, load_stored_config


def test_a_hand_tick_survives_the_round_trip_every_writer_performs():
    """Validate → dump → validate: what a PUT, an `admin_config load` and the workbook import
    each do to the whole document on every write."""
    once = DeploymentConfigIn(setup={"acknowledged": ["fleet"]}).model_dump(mode="json")
    twice = load_stored_config(once).model_dump(mode="json")

    assert twice["setup"]["acknowledged"] == ["fleet"]


def test_a_document_that_never_mentions_it_gets_an_empty_section_not_a_missing_one():
    assert DeploymentConfigIn().setup.acknowledged == []
    assert load_stored_config({}).setup.acknowledged == []


def test_a_key_this_version_no_longer_shows_is_kept_rather_than_dropped():
    """The card's row set changes with the product. A tick for a row that is not rendered today
    must come back if the row does — dropping it would silently re-open a settled question."""
    stored = load_stored_config({"setup": {"acknowledged": ["fleet", "some-row-from-a-later-version"]}})

    assert stored.setup.acknowledged == ["fleet", "some-row-from-a-later-version"]


def test_the_section_ignores_what_it_cannot_use_instead_of_refusing_the_document():
    """A malformed `setup` must never make the whole config unloadable: the document carries the
    station's map, fleet and doctrine, and none of that may be held hostage by a checklist tick."""
    assert SetupConfig(acknowledged=["fleet"], somethingElse=1).acknowledged == ["fleet"]
