"""`alarmKeywords` reaches an admin session only — and MUST NOT be withheld from an admin.

WHY BOTH HALVES ARE HERE
------------------------
A station's whole alarm vocabulary has no reader in the frontend: matching happens server-side,
so publishing it is surface for nothing. A caller without a session gets the short public list
(`test_config_public_parts.py`), a PIN or link session the document without this block. The
`alarmVocabulary` *summary* (source, schema version, counts) goes to every session, because
"is my override live?" has to be answerable without the admin secret.

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
async def test_anonymous_get_does_not_expose_the_vocabulary(client, admin_login, put_config):
    """The words themselves never reach an unauthenticated caller."""
    await admin_login(client)
    vocab = {
        "schema_version": 1,
        "keyword_to_category": {"pairs": [["FEUER", "brandbekaempfung"]]},
        "fallback_category": "diverse_einsaetze",
        "high_priority_keywords": {"groups": [{"group": "Brand", "keywords": ["FEUER"]}]},
    }
    r = await put_config(client, {"alarmKeywords": vocab})
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
async def test_a_session_still_learns_which_vocabulary_is_active(client, admin_login, put_config, editor):
    """The summary goes to every session: counts and source, never the words. A caller without a
    session gets neither (20.11.2026: the public answer is a short list)."""
    await admin_login(client)
    await put_config(
        client,
        {
            "alarmKeywords": {
                "schema_version": 1,
                "keyword_to_category": {"pairs": [["FEUER", "brandbekaempfung"]]},
                "fallback_category": "diverse_einsaetze",
                "high_priority_keywords": {"groups": [{"group": "Brand", "keywords": ["FEUER"]}]},
            }
        },
    )
    client.cookies.clear()
    assert "alarmVocabulary" not in (await client.get("/api/config")).json()

    assert (await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": "135790"})).status_code == 200
    body = (await client.get("/api/config")).json()
    assert body.get("alarmKeywords") is None, "the words reached a PIN session"
    summary = body["alarmVocabulary"]
    assert summary["source"] == "deployment"
    assert summary["titleKeywords"] == 1
    assert summary["fallbackCategory"] == "diverse_einsaetze"


@pytest.mark.asyncio
async def test_admin_get_round_trips_the_vocabulary(client, admin_login, put_config):
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
    await put_config(client, {"alarmKeywords": vocab})

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
    r = await put_config(client, draft)
    assert r.status_code == 200, r.text

    # 4. The vocabulary is still there.
    after = (await client.get("/api/config")).json()
    assert after["identity"]["appName"] == "Feuerwehr Musterdorf"
    assert after["alarmKeywords"] is not None, "the round-trip deleted the station's vocabulary"
    assert after["alarmVocabulary"]["source"] == "deployment"


@pytest.mark.asyncio
async def test_the_kategorien_labels_are_served_to_every_session_in_picker_order(client, editor):
    """Sweep B.9: the wizard's Kategorie picker reads the server's labels – there is no second
    list in the frontend to drift. The wizard is behind the login, so the labels are too."""
    from app.divera import CATEGORY_LABELS

    assert (await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": "135790"})).status_code == 200
    served = (await client.get("/api/config")).json()["categoryLabels"]
    assert list(served.items()) == list(CATEGORY_LABELS.items())
    assert next(iter(served.values())) == "Brandbekämpfung"  # the wizard's default
