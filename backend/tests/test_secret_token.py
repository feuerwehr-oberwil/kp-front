"""The shared secret gate (`app.auth.secret_token`) — the rule eight surfaces now share.

Worth its own test because the two refusals are not interchangeable: an unconfigured secret
must fail CLOSED with 403 («this surface is off»), and only a configured-but-wrong token is a
401. A gate that answered 401 for both would still look fine in every integration test, while
a deployment that never set a secret quietly accepted whatever a caller sent.
"""

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from app.auth.secret_token import SecretGate

GATE = SecretGate(query_param="t", disabled_detail="Export deaktiviert", invalid_detail="Ungültiger Token")


def _request(query: str = "") -> Request:
    return Request({"type": "http", "method": "GET", "path": "/x", "query_string": query.encode(), "headers": []})


def test_unset_secret_fails_closed() -> None:
    """No secret configured → 403, even when the caller sends something."""
    for expected in (None, ""):
        with pytest.raises(HTTPException) as e:
            GATE.check(expected, "whatever")
        assert e.value.status_code == 403
        assert e.value.detail == "Export deaktiviert"


@pytest.mark.parametrize("provided", [None, "", "nope"])
def test_missing_or_wrong_token_is_401(provided: str | None) -> None:
    with pytest.raises(HTTPException) as e:
        GATE.check("s3cret", provided)
    assert e.value.status_code == 401
    assert e.value.detail == "Ungültiger Token"


def test_token_accepted_from_query_or_header() -> None:
    """Both travel paths work, and the query parameter wins when both are present."""
    GATE.check_request("s3cret", _request("t=s3cret"), None)
    GATE.check_request("s3cret", _request(), "s3cret")
    GATE.check_request("s3cret", _request("t=s3cret"), "wrong-header")


def test_header_only_gate_ignores_the_query_string() -> None:
    """A gate without a query parameter (the print relay) must not read one — a secret in the
    URL is a secret in every proxy log, and declaring none is how a surface refuses that."""
    header_only = SecretGate(disabled_detail="off", invalid_detail="nope")
    header_only.check_request("s3cret", _request(), "s3cret")
    with pytest.raises(HTTPException) as e:
        header_only.check_request("s3cret", _request("secret=s3cret&t=s3cret"), None)
    assert e.value.status_code == 401
