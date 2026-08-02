"""`alarmKeywords` is withheld from anonymous GET — and MUST NOT be withheld from an admin.

WHY BOTH HALVES ARE HERE
------------------------
`GET /api/config` is public on purpose: the login screen needs branding before anyone can log
in. Every section of the document therefore ships to unauthenticated callers, and one of them
should not: a station's whole alarm vocabulary. Matching happens server-side and nothing in the
frontend reads it, so publishing it is surface for nothing. The `alarmVocabulary` *summary*
(source, schema version, counts) stays public, because "is my override live?" has to be
answerable without a session.

The second half is the one that actually bites, and it is the reason this is a flag on the
projection rather than a blanket drop. **The admin UI does a full-document PUT**
(`src/admin/ConfigContext.tsx`: GET → hold as draft → PUT the whole draft back). So a section
the admin never *received* is a section the next unrelated edit silently **deletes** — change
the app name, lose the vocabulary. Withholding from an admin would not be a tightening, it
would be data loss with a plausible-looking cause.

The UI already strips `integrations` and `symbols` before its PUT, but neither of those is
stored config the server would interpret as "unset it". `alarmKeywords` is.

So: anonymous callers must NOT see it, admins MUST, and both directions are pinned below.
"""

import pytest


@pytest.mark.asyncio
async def test_anonymous_get_does_not_expose_the_vocabulary(client, admin_login):
    """The words themselves never reach an unauthenticated caller."""
    await admin_login(client)
    vocab = {
        "schema_version": 1,
        "keyword_to_category": {"pairs": [["FEUER", "brandbekaempfung"]]},
        "fallback_category": "diverse_einsaetze",
        "high_priority_keywords": {"groups": [{"group": "Brand", "keywords": ["FEUER"]}]},
    }
    r = await client.put("/api/config", json={"alarmKeywords": vocab})
    assert r.status_code == 200, r.text

    # Drop the admin session: this is now the login screen's view of the world.
    client.cookies.clear()
    anon = await client.get("/api/config")
    assert anon.status_code == 200
    body = anon.json()

    assert body.get("alarmKeywords") is None, "the deployment's alarm vocabulary reached an unauthenticated caller"
    # The words must not arrive by some other route either (a future field, a nested echo).
    assert "FEUER" not in anon.text, "a keyword leaked into the public config payload"


@pytest.mark.asyncio
async def test_anonymous_still_learns_which_vocabulary_is_active(client, admin_login):
    """The summary is deliberately public: counts and source, never the words."""
    await admin_login(client)
    await client.put(
        "/api/config",
        json={
            "alarmKeywords": {
                "schema_version": 1,
                "keyword_to_category": {"pairs": [["FEUER", "brandbekaempfung"]]},
                "fallback_category": "diverse_einsaetze",
                "high_priority_keywords": {"groups": [{"group": "Brand", "keywords": ["FEUER"]}]},
            }
        },
    )
    client.cookies.clear()

    summary = (await client.get("/api/config")).json()["alarmVocabulary"]
    assert summary["source"] == "deployment"
    assert summary["titleKeywords"] == 1
    assert summary["fallbackCategory"] == "diverse_einsaetze"


@pytest.mark.asyncio
async def test_admin_get_round_trips_the_vocabulary(client, admin_login):
    """🔴 The data-loss guard.

    The admin UI GETs the config, holds it as its draft, and PUTs the whole draft back. If the
    admin's GET omitted `alarmKeywords`, the next unrelated edit would silently delete a
    station's vocabulary. This test reproduces that exact cycle: read as admin, change one
    unrelated field, write the whole document back, and assert the vocabulary survived.
    """
    await admin_login(client)
    vocab = {
        "schema_version": 1,
        "keyword_to_category": {"pairs": [["FEUER", "brandbekaempfung"]]},
        "fallback_category": "diverse_einsaetze",
        "high_priority_keywords": {"groups": [{"group": "Brand", "keywords": ["FEUER"]}]},
    }
    await client.put("/api/config", json={"alarmKeywords": vocab})

    # 1. The UI reads.
    draft = (await client.get("/api/config")).json()
    assert draft.get("alarmKeywords") is not None, (
        "an admin GET withheld alarmKeywords — the UI's next full-document PUT would erase it"
    )

    # 2. The admin edits something entirely unrelated.
    draft.setdefault("identity", {})["appName"] = "Feuerwehr Musterdorf"

    # 3. The UI writes the whole draft back, minus the read-only sections it always strips.
    draft.pop("integrations", None)
    draft.pop("alarmVocabulary", None)
    r = await client.put("/api/config", json=draft)
    assert r.status_code == 200, r.text

    # 4. The vocabulary is still there.
    after = (await client.get("/api/config")).json()
    assert after["identity"]["appName"] == "Feuerwehr Musterdorf"
    assert after["alarmKeywords"] is not None, "the round-trip deleted the station's vocabulary"
    assert after["alarmVocabulary"]["source"] == "deployment"
