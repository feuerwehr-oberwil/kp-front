"""The guards a full-document config write has to pass — the same ones, whoever is writing.

Every one of these started life inside ``admin_config``, which means they protected the one
caller that already had somebody at a terminal reading its output. ``PUT /api/config`` had
almost none of them: it carried ``identity.assets`` over and checked ``If-Match`` from a
browser, and that was it. So a script, an agent or a curl one-liner could do over the API
exactly what the CLI spends forty lines refusing to do — publish an old document that empties a
station's Dienstgrade, its Doktrin and its Partnerorganisationen, or omit ``referenceLayers``
and delete its hydrants — and be answered 200.

This module is that logic in one place, used by the API and by the CLI:

* :func:`carry_runtime_sections` — the sections nobody types, kept when the write is silent
  about them;
* :func:`ignored_keys` / :func:`layer_warnings` / :func:`document_warnings` — what the schema
  dropped and which layers cannot resolve, because ``extra="ignore"`` makes a typo look like an
  intent;
* :func:`format_validation_errors` — a pydantic failure as ``field.path: message`` lines.

The fourth guard, «this write would EMPTY a populated section», is :func:`emptied_sections` in
app/config_history — it lives there because the history list reads it too, and it is re-exported
here so a write path needs one import. An HTTP caller is answered on
:func:`emptied_declared_sections` instead, which says why.
"""

import difflib
from typing import Any, get_args, get_origin

from pydantic import BaseModel, ValidationError

from .config_history import emptied_sections
from .schemas import DeploymentConfigIn

__all__ = [
    "RESPONSE_ONLY_FIELDS",
    "RUNTIME_SECTIONS",
    "carry_runtime_sections",
    "document_warnings",
    "emptied_declared_sections",
    "emptied_sections",
    "format_validation_errors",
    "ignored_keys",
    "layer_warnings",
]

#: Sections of the config document that are NOT config-as-code: they are written at RUNTIME by
#: the other admin paths — `identity.assets` by a branding upload (admin UI or admin_branding),
#: `referenceLayers` by a geodata push or the SharePoint pull — and no config file names them,
#: because the URLs inside them only exist once the blob has been stored.
#:
#: ⚠️ A write that does not mention them therefore used to DELETE them. That is how the public
#: demo lost its logo: the reset script loads the config first and re-pushes logo + geodata
#: afterwards, so a run that fails in between leaves a demo with no brandmark and no hydrants —
#: which is exactly what happened on 08.08. And it is the same trap for a station: upload a logo
#: in the admin UI, load a config change from the repo an hour later, logo gone, nothing said.
RUNTIME_SECTIONS: tuple[str, ...] = ("referenceLayers",)

#: Fields the RESPONSE carries and the document does not: env-derived integration flags, the
#: computed vocabulary summary, the version token, these warnings themselves. Every caller that
#: GETs the document, edits one field and PUTs the whole thing back — which is what the admin UI
#: does on every autosave — hands them straight back, and `extra="ignore"` drops them. So they
#: are not typos and must not be reported as dropped keys: four bogus warnings on every save is
#: how a report nobody reads is made.
RESPONSE_ONLY_FIELDS: tuple[str, ...] = ("integrations", "alarmVocabulary", "version", "warnings")


def carry_runtime_sections(
    stored: dict[str, Any] | None,
    incoming: dict[str, Any],
    *,
    submitted: set[str] | None = None,
) -> list[str]:
    """Copy the runtime-written sections from ``stored`` into ``incoming`` — MUTATED in place —
    wherever the write does not state them. Returns the names carried, for the caller to report.

    ``submitted`` is the set of top-level keys the caller actually NAMED. An HTTP caller passes
    the raw request body's keys, because over the wire «absent» and «present but empty» are two
    different requests: the first is a caller that does not know the section exists, the second
    is one asking to clear it — and only the second should reach the refuse-to-empty guard. A
    FILE has no distinction worth honouring there (an empty ``referenceLayers`` block is what an
    example file leaves behind), so the CLI passes ``None`` and keeps the falsy test.

    ``identity.assets`` sits one level down and is carried whatever the caller said, because the
    document body is simply not where the brandmark is edited: the slots are written by the
    upload endpoints (app/api/branding.py) and by ``admin_branding push``, and removing one is
    ``DELETE /api/branding/{slot}``. Merged per SLOT rather than only when the incoming block is
    empty — a draft carrying a logo but a null favicon is how a station loses one mark and keeps
    the other, which is harder to notice than losing both.
    """
    if not stored:
        return []
    carried: list[str] = []
    for key in RUNTIME_SECTIONS:
        stated = key in submitted if submitted is not None else bool(incoming.get(key))
        if stored.get(key) and not stated:
            incoming[key] = stored[key]
            carried.append(key)
    # Only slots that are SET: an assets block of nothing but nulls is not a brandmark, and
    # `DELETE /api/branding/{slot}` must not be undone by the next config save.
    assets = {k: v for k, v in ((((stored.get("identity") or {}).get("assets")) or {}).items()) if v}
    if assets:
        identity = dict(incoming.get("identity") or {})
        merged = {**(identity.get("assets") or {}), **assets}
        if merged != (identity.get("assets") or {}):
            identity["assets"] = merged
            incoming["identity"] = identity
            carried.append("identity.assets")
    return carried


def emptied_declared_sections(stored: dict[str, Any] | None, final: dict[str, Any]) -> list[str]:
    """:func:`emptied_sections`, minus the sections this build's schema does not declare.

    ⚠️ The filter is what keeps the refusal ACTIONABLE. A section the model has dropped
    (``symbols``, once) is removed by normalization whatever the caller sends, so reporting it
    would refuse every write — including the admin UI's, which strips ``symbols`` from its own
    payload precisely because the schema ignores it — with a reason no caller can do anything
    about. Same for a section a NEWER build wrote into the row: a station running an older image
    cannot put it back, and locking its configuration until somebody passes ``?force=true`` is
    not a proportionate answer to a downgrade.

    The CLI's refusal needs no such filter and does not use this: it is about a FILE, and a file
    somebody can read is a file somebody can edit.
    """
    declared = set(DeploymentConfigIn.model_fields)
    return [section for section in emptied_sections(stored, final) if section.split(".")[0] in declared]


def _object_fields(annotation: Any) -> set[str] | None:
    """Field names of a section that is itself an OBJECT, else None (lists and scalars).

    Used to check a document's second level. Lists return None on purpose: their entries are
    ``extra="ignore"`` too, but a typo inside one of fifty layer entries is a different (and much
    noisier) report than a misspelled section.
    """
    if get_origin(annotation) is list:
        return None
    if isinstance(annotation, type) and issubclass(annotation, BaseModel):
        return set(annotation.model_fields)
    for arg in get_args(annotation):  # `X | None`
        if isinstance(arg, type) and issubclass(arg, BaseModel):
            return set(arg.model_fields)
    return None


def _did_you_mean(name: str, candidates: set[str]) -> str | None:
    """The one obviously-intended key, or None. Deliberately strict: a wrong suggestion is worse
    than none, because it reads as confirmation that the document is nearly right."""
    match = difflib.get_close_matches(name, sorted(candidates), n=1, cutoff=0.7)
    return match[0] if match else None


def ignored_keys(raw: dict[str, Any]) -> list[str]:
    """Keys in the SUBMITTED document that the schema silently drops — ``identitiy → identity?``.

    Every config model is ``extra="ignore"``, which is what keeps an older deployment able to read
    a newer document. The price is that a typo is indistinguishable from an intent: ``identitiy`` /
    ``map.defaultview`` / ``doctrin`` all validate clean and configure NOTHING, and the writer's
    only feedback was an «OK» — a 200, over the API. Checked two levels deep — top-level sections
    and their fields — which is where the config's meaning lives.
    """
    known = {name: _object_fields(f.annotation) for name, f in DeploymentConfigIn.model_fields.items()}
    out: list[str] = []
    for key, val in raw.items():
        if key in RESPONSE_ONLY_FIELDS:
            continue
        if key not in known:
            suggestion = _did_you_mean(key, set(known))
            out.append(f"{key}{f' — did you mean {suggestion}?' if suggestion else ''}")
            continue
        subs = known[key]
        if subs is None or not isinstance(val, dict):
            continue
        for sub in val:
            if sub in subs:
                continue
            suggestion = _did_you_mean(sub, subs)
            out.append(f"{key}.{sub}{f' — did you mean {key}.{suggestion}?' if suggestion else ''}")
    return out


def layer_warnings(doc_json: dict[str, Any]) -> list[str]:
    """Reference layers whose ``geojson`` source cannot resolve on the deployment.

    The frontend hands the string straight to MapLibre as a URL (src/lib/deploymentConfig ·
    mapReferenceLayers), so only two shapes work: the reference store this deployment serves
    itself, ``/api/reference/geo:<slug>``, or an absolute ``https://`` source. A bare
    ``hydranten.geojson`` resolves against the app's own routes and 404s — the layer appears in
    the Ebenen panel and simply draws nothing.

    Advisory, never fatal, and deliberately NOT a schema rule: ``referenceLayers`` is written by
    the geodata push and the stored documents of running stations are never re-validated, so a
    hard constraint here would turn a station's existing config into an unloadable one.
    """
    out: list[str] = []
    for layer in doc_json.get("referenceLayers") or []:
        if not isinstance(layer, dict):
            continue
        url = layer.get("geojson")
        if not isinstance(url, str) or not url:
            continue
        if url.startswith(("/api/reference/geo:", "https://")):
            continue
        out.append(
            f"referenceLayer {layer.get('id')!r}: geojson {url!r} is neither "
            "«/api/reference/geo:<slug>» (loaded by admin_geodata) nor an absolute https:// URL — "
            "the layer will draw nothing"
        )
    return out


def document_warnings(raw: dict[str, Any], doc_json: dict[str, Any]) -> list[str]:
    """The advisory lines a write path owes its caller, as flat strings.

    The same two reports the CLI prints under its OK line (``admin_config · _report_notes``),
    shaped for an API response body: a write that warns still wrote, so these are neither errors
    nor a refusal — they are the only thing standing between a misspelled section and a
    configuration that silently does nothing.
    """
    return [f"ignored: {line}" for line in ignored_keys(raw)] + layer_warnings(doc_json)


def format_validation_errors(err: ValidationError) -> list[str]:
    """A pydantic failure as precise ``field.path: message [type]`` lines."""
    out: list[str] = []
    for e in err.errors():
        loc = ".".join(str(p) for p in e["loc"]) or "(root)"
        out.append(f"{loc}: {e['msg']} [{e['type']}]")
    return out
