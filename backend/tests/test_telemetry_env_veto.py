"""The deployer's telemetry veto must actually bind to the documented variable names.

PRIVACY.md tells an operator to put ``KP_TELEMETRY_ENABLED=0`` in their compose file and
promises it "outranks the admin switch, so no later click can turn it on". That promise is
only worth anything if the name in the docs is a name pydantic actually reads.

It very nearly wasn't, and it was broken twice over:

1. ``Settings`` has no ``env_prefix``, so every field binds to its bare upper-cased name —
   ``TELEMETRY_ENABLED``, not ``KP_TELEMETRY_ENABLED``. The KP_ spelling was in the docs, in
   both .env.example files and in the shipped UI copy, and bound to nothing at all.
2. ``docker-compose.yml`` passed no telemetry variable into the container, so even the
   correct name in .env would have done nothing — compose's .env is interpolation-only.

Consent defaults to off in the database so nothing was being transmitted, but a station that
had *enforced* the ban per the documentation had not enforced anything.

This pins both halves. If it fails because someone removed the ``AliasChoices``, the fix is
to put them back, not to relax the test — the KP_ name is the published one.
"""

import re
from pathlib import Path

import pytest

from app.config import Settings
from app.telemetry.dsn import UPSTREAM_DSN

REPO_ROOT = Path(__file__).resolve().parents[2]

TELEMETRY_ENV_VARS = (
    "KP_TELEMETRY_ENABLED",
    "TELEMETRY_ENABLED",
    "KP_TELEMETRY_DSN",
    "TELEMETRY_DSN",
    "KP_TELEMETRY_FLUSH_MINUTES",
    "TELEMETRY_FLUSH_MINUTES",
)


@pytest.fixture(autouse=True)
def _clear_telemetry_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Start every case from "nothing set", whatever the developer's shell holds."""
    for name in TELEMETRY_ENV_VARS:
        monkeypatch.delenv(name, raising=False)


@pytest.mark.parametrize("var", ["KP_TELEMETRY_ENABLED", "TELEMETRY_ENABLED"])
@pytest.mark.parametrize("falsy", ["0", "false", "False", "no", ""])
def test_either_spelling_disables_telemetry(monkeypatch: pytest.MonkeyPatch, var: str, falsy: str) -> None:
    """The documented KP_ name and the bare name must both switch the transport off.

    The empty string is in the list on purpose: it is what compose forwards for a variable
    the operator set to nothing, and the safe reading of that is "don't send".
    """
    monkeypatch.setenv(var, falsy)
    assert Settings(_env_file=None).telemetry_enabled is False


@pytest.mark.parametrize("var", ["KP_TELEMETRY_DSN", "TELEMETRY_DSN"])
def test_either_spelling_redirects_the_dsn(monkeypatch: pytest.MonkeyPatch, var: str) -> None:
    """A station aiming the machinery at its own GlitchTip must not still reach ours."""
    own_ingest = "https://deadbeef@glitchtip.example.ch/7"
    monkeypatch.setenv(var, own_ingest)
    settings = Settings(_env_file=None)
    assert settings.telemetry_dsn == own_ingest
    assert settings.telemetry_dsn != UPSTREAM_DSN


@pytest.mark.parametrize("var", ["KP_TELEMETRY_FLUSH_MINUTES", "TELEMETRY_FLUSH_MINUTES"])
def test_either_spelling_sets_the_flush_interval(monkeypatch: pytest.MonkeyPatch, var: str) -> None:
    """Both spellings are accepted here too, so the trio has no odd one out."""
    monkeypatch.setenv(var, "42")
    assert Settings(_env_file=None).telemetry_flush_minutes == 42


def test_kp_prefix_wins_when_both_are_set(monkeypatch: pytest.MonkeyPatch) -> None:
    """KP_ is the documented name, so it outranks the bare one rather than racing it."""
    monkeypatch.setenv("KP_TELEMETRY_ENABLED", "0")
    monkeypatch.setenv("TELEMETRY_ENABLED", "1")
    assert Settings(_env_file=None).telemetry_enabled is False


def test_defaults_are_unchanged_when_nothing_is_set() -> None:
    """The aliases must not have quietly altered what an untouched install does."""
    settings = Settings(_env_file=None)
    assert settings.telemetry_enabled is True
    assert settings.telemetry_dsn == UPSTREAM_DSN
    assert settings.telemetry_flush_minutes == 5


def test_compose_passes_the_veto_into_the_container() -> None:
    """The alias is only half the fix — compose has to forward the variable at all.

    Without this the veto is inert again for exactly the deployment everyone actually runs,
    and nothing else in the suite would notice: the app-level tests above would still pass.
    """
    compose = (REPO_ROOT / "docker-compose.yml").read_text(encoding="utf-8")
    assert "KP_TELEMETRY_ENABLED:" in compose, "compose no longer forwards the telemetry veto"
    assert "KP_TELEMETRY_DSN:" in compose, "compose no longer forwards the telemetry DSN"


def test_compose_fallbacks_do_not_silently_disable_telemetry() -> None:
    """The compose fallbacks must repeat the app defaults, not be blank.

    Blank is not "unset" to this app: a blank flag and a blank DSN each mean "off". A
    `${KP_TELEMETRY_ENABLED:-}` would therefore disable telemetry for every compose
    deployment while looking like an innocent passthrough — the opposite failure to the one
    this file exists for, and just as invisible.
    """
    compose = (REPO_ROOT / "docker-compose.yml").read_text(encoding="utf-8")

    enabled = re.search(r"KP_TELEMETRY_ENABLED:\s*\$\{KP_TELEMETRY_ENABLED([:-]-?)([^}]*)\}", compose)
    assert enabled, "could not find the KP_TELEMETRY_ENABLED passthrough"
    assert enabled.group(2).strip() == "1", "blank/false fallback would disable telemetry by default"

    dsn = re.search(r"KP_TELEMETRY_DSN:\s*\$\{KP_TELEMETRY_DSN([:-]-?)([^}]*)\}", compose)
    assert dsn, "could not find the KP_TELEMETRY_DSN passthrough"
    assert dsn.group(2).strip() == UPSTREAM_DSN, (
        "compose's default DSN has drifted from UPSTREAM_DSN in app/telemetry/dsn.py"
    )
    # `:-` substitutes on empty as well as unset, which would take the operator's deliberate
    # "blank = off" away from them. Only the bare `-` form is correct here.
    assert dsn.group(1) == "-", "use ${KP_TELEMETRY_DSN-default}, not ${KP_TELEMETRY_DSN:-default}"
