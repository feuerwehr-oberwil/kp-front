"""Staging never writes to an external archive unless told so (config · external_delivery_allowed).

Hunt 24.11.2026, ops-integrations F1: a staging refresh copies prod's archive destinations and
export credentials, and staging's own scheduler would deliver with them into prod's SharePoint."""

import pytest

from app.config import external_delivery_allowed
from app.object_visit_sharepoint import export_credentials

_ENV = ("ENVIRONMENT", "APP_ENV", "RAILWAY_ENVIRONMENT_NAME", "RAILWAY_ENVIRONMENT", "STAGING_EXTERNAL_DELIVERY")


@pytest.fixture
def env(monkeypatch):
    for name in _ENV:
        monkeypatch.delenv(name, raising=False)
    return monkeypatch


@pytest.mark.parametrize(
    "variables,allowed",
    [
        ({}, True),
        ({"RAILWAY_ENVIRONMENT_NAME": "production"}, True),
        ({"RAILWAY_ENVIRONMENT_NAME": "staging"}, False),
        ({"RAILWAY_ENVIRONMENT": "staging"}, False),
        ({"ENVIRONMENT": "staging"}, False),
        ({"RAILWAY_ENVIRONMENT_NAME": "staging", "STAGING_EXTERNAL_DELIVERY": "1"}, True),
    ],
)
def test_staging_closes_external_delivery(env, variables, allowed):
    for name, value in variables.items():
        env.setenv(name, value)
    assert external_delivery_allowed() is allowed


def test_staging_hides_complete_export_credentials_from_every_writer(env):
    import app.object_visit_sharepoint as sp

    env.setattr(sp, "credential", lambda name: "set")
    assert export_credentials() == ("set", "set", "set")
    env.setenv("RAILWAY_ENVIRONMENT_NAME", "staging")
    assert export_credentials() is None
