#!/usr/bin/env python3
"""Do KP Front and KP Rück still hold the same copies of the files they share?

The two products share a handful of files by COPY, never by package or import
(docs/RUNNING-BOTH.md in kp-rueck): the telemetry sanitiser, the alarm keyword vocabulary,
the roster-snapshot contract and its reader, the alarm intake corpus, the loading snail.
Every one of them is listed in ``shared/MANIFEST.json`` with its path in each repository,
the repository that OWNS it (an edit is made there first) and its sha256. This script, the
manifest and ``shared/README.md`` are byte-identical in both repositories.

    python3 scripts/check_shared.py                 # this checkout's files match the manifest
    python3 scripts/check_shared.py --sibling DIR   # ...and DIR, a checkout of the other repo, agrees
    python3 scripts/check_shared.py --update        # re-record the sha256 of this checkout's files

With ``--sibling`` it checks, per manifest item: our files against our manifest, theirs against
theirs, ours against theirs byte for byte (with a diff), and the two manifest entries against
each other. CI runs exactly that against the sibling's branch of the SAME NAME when one exists,
else its default branch, so a change made in both repositories on equally named branches is
green in both pull requests at once (shared/README.md).

Exit 0: everything matches. 1: drift, one reason per line. 2: usage error or unreadable manifest.
Standard library only, so CI runs it with the runner's python3 before installing anything.
"""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import os
import sys
from pathlib import Path

MANIFEST = "shared/MANIFEST.json"
HOW_TO = "shared/README.md"
ROOT = Path(__file__).resolve().parent.parent
DIFF_LINES = 120


class ManifestError(Exception):
    """The manifest is missing, unreadable or malformed — a usage error, not drift."""


def load(root: Path) -> tuple[dict, str]:
    path = root / MANIFEST
    try:
        raw = path.read_text(encoding="utf-8")
        manifest = json.loads(raw)
    except (OSError, ValueError) as error:
        raise ManifestError(f"cannot read {path}: {error}") from error
    validate(manifest)
    return manifest, raw


def validate(manifest: dict) -> None:
    repos = manifest.get("repos")
    if not isinstance(repos, dict) or len(repos) != 2:
        raise ManifestError('"repos" must name exactly two repositories')
    for repo, about in repos.items():
        if not about.get("name") or not about.get("marker"):
            raise ManifestError(f"repos.{repo} needs a display name and a marker file")
    seen: set[str] = set()
    for item in manifest.get("items", []):
        ident = item.get("id")
        if not ident or ident in seen:
            raise ManifestError(f"item id {ident!r} is missing or used twice")
        seen.add(ident)
        if item.get("owner") not in repos:
            raise ManifestError(f"{ident}: owner must be one of {sorted(repos)}")
        if not item.get("title") or not item.get("question"):
            raise ManifestError(f"{ident}: needs a title and the question a drift would answer")
        if not item.get("files"):
            raise ManifestError(f"{ident}: lists no files")
        for entry in item["files"]:
            for repo in repos:
                rel = path_in(entry, repo)
                if not rel or rel.startswith("/") or ".." in Path(rel).parts:
                    raise ManifestError(f"{ident}: bad path {rel!r} for {repo}")
            digest = entry.get("sha256", "")
            if len(digest) != 64 or set(digest) - set("0123456789abcdef"):
                raise ManifestError(f"{ident}: {path_in(entry, next(iter(repos)))} has no valid sha256")


def canonical(manifest: dict) -> str:
    """The one byte form of a manifest, so two that mean the same thing are the same bytes."""
    return json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"


def path_in(entry: dict, repo: str) -> str:
    """A file's path in `repo`: its own key when the two repositories differ, else `path`."""
    return entry.get(repo) or entry.get("path") or ""


def detect(root: Path, manifest: dict) -> str:
    """Which repository `root` is, by the marker file only that repository has."""
    hits = [repo for repo, about in manifest["repos"].items() if (root / about["marker"]).exists()]
    if len(hits) != 1:
        raise ManifestError(f"cannot tell which repository {root} is (markers found: {hits}); pass --repo")
    return hits[0]


def digest_of(path: Path) -> str | None:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return None


def diff(theirs: Path, ours: Path, their_label: str, our_label: str) -> list[str]:
    try:
        a = theirs.read_text(encoding="utf-8").splitlines(keepends=True)
        b = ours.read_text(encoding="utf-8").splitlines(keepends=True)
    except (OSError, UnicodeDecodeError):
        return ["    (binary or unreadable — no diff)"]
    lines = [f"    {line.rstrip()}" for line in difflib.unified_diff(a, b, their_label, our_label)]
    if len(lines) > DIFF_LINES:
        lines = [*lines[:DIFF_LINES], f"    … {len(lines) - DIFF_LINES} more diff lines"]
    return lines


def check_item(
    item: dict, root: Path, repo: str, names: dict[str, str], sibling: tuple[Path, str, dict | None] | None
) -> list[str]:
    """Every problem with one manifest item, as human lines. Empty when it holds."""
    problems: list[str] = []
    for entry in item["files"]:
        rel = path_in(entry, repo)
        ours = root / rel
        mine = digest_of(ours)
        if mine is None:
            problems.append(f"{rel} is missing here")
        elif mine != entry["sha256"]:
            problems.append(f"{rel} changed here, but {MANIFEST} still records its old sha256")
        if sibling is None:
            continue
        sib_root, sib_repo, sib_item = sibling
        their_rel = path_in(entry, sib_repo)
        theirs = sib_root / their_rel
        their_digest = digest_of(theirs)
        if their_digest is None:
            problems.append(f"{their_rel} is missing in {names[sib_repo]}")
            continue
        if sib_item is not None:
            recorded = {path_in(e, sib_repo): e["sha256"] for e in sib_item["files"]}.get(their_rel)
            if recorded is not None and recorded != their_digest:
                problems.append(f"{names[sib_repo]}'s {their_rel} does not match {names[sib_repo]}'s own manifest")
        if mine is not None and mine != their_digest:
            where = "copy" if their_rel == rel else their_rel
            problems.append(f"{rel} differs from {names[sib_repo]}'s {where}:")
            problems.extend(diff(theirs, ours, f"{names[sib_repo]}/{their_rel}", f"{names[repo]}/{rel}"))
    if sibling is not None:
        sib_item = sibling[2]
        if sib_item is None:
            problems.append(f"{names[sibling[1]]}'s {MANIFEST} has no item {item['id']!r}")
        elif sib_item != item:
            problems.append(f"the {item['id']!r} entry in {MANIFEST} differs between the two repositories")
    return problems


Results = list[tuple[dict | None, list[str]]]


def run(root: Path, repo: str | None, sibling_root: Path | None) -> tuple[Results, dict[str, str]]:
    """(item, problems) for every item — item None for the manifest as a whole — and the
    display name of each repository."""
    manifest, raw = load(root)
    repo = repo or detect(root, manifest)
    other = next(r for r in manifest["repos"] if r != repo)
    names = {key: about["name"] for key, about in manifest["repos"].items()}
    results: Results = []
    whole: list[str] = []
    if raw != canonical(manifest):
        whole.append(f"{MANIFEST} is not in its canonical form — run this script with --update")
    sib_items: dict[str, dict] = {}
    sibling = None
    if sibling_root is not None:
        sib_manifest, sib_raw = load(sibling_root)
        sib_items = {item["id"]: item for item in sib_manifest["items"]}
        if sib_raw != raw:
            whole.append(f"{MANIFEST} is not byte-identical with {names[other]}'s")
        for ident in sorted(set(sib_items) - {item["id"] for item in manifest["items"]}):
            whole.append(f"{names[other]} shares {ident!r}, which this manifest does not list")
    results.append((None, whole))
    for item in manifest["items"]:
        if sibling_root is not None:
            sibling = (sibling_root, other, sib_items.get(item["id"]))
        results.append((item, check_item(item, root, repo, names, sibling)))
    return results, names


def update(root: Path, repo: str | None) -> int:
    manifest, _ = load(root)
    repo = repo or detect(root, manifest)
    for item in manifest["items"]:
        for entry in item["files"]:
            rel = path_in(entry, repo)
            digest = digest_of(root / rel)
            if digest is None:
                print(f"{rel} is missing — restore it or remove it from the manifest by hand", file=sys.stderr)
                return 1
            if digest != entry["sha256"]:
                print(f"  {item['id']}: {rel} → {digest[:12]}…")
                entry["sha256"] = digest
    (root / MANIFEST).write_text(canonical(manifest), encoding="utf-8")
    print(f"{MANIFEST} records this checkout. Copy the changed files AND the manifest to the other repository.")
    return 0


def report(results: Results, names: dict[str, str], sibling: bool) -> int:
    annotate = os.environ.get("GITHUB_ACTIONS") == "true"
    failed = False
    for item, problems in results:
        label = "manifest" if item is None else f"{item['id']} — {item['title']}"
        if not problems:
            print(f"  ✓ {label}")
            continue
        failed = True
        print(f"  ✗ {label}")
        for line in problems:
            print(f"      {line}" if not line.startswith("    ") else f"  {line}")
        if annotate:
            first = next(line for line in problems if not line.startswith("    "))
            print(f"::error title=Shared files · {label}::{first}")
        if item is not None:
            print(f"      Owned by {names[item['owner']]}: {item['question']}")
    if not failed:
        return 0
    print()
    print("These files are shared by copy between KP Front and KP Rück. To change one: edit it in the")
    print("owning repository, copy it byte for byte to the other, run")
    print("`python3 scripts/check_shared.py --update` in BOTH, and open the two pull requests on")
    print("branches with the SAME name — each CI then compares against the other's branch and both")
    print(f"go green together. Step by step: {HOW_TO}.")
    if not sibling:
        print("Not changing it on purpose? Restore the file: `git checkout -- <path>`.")
    return 1


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--sibling", type=Path, help="a checkout of the other repository to compare against")
    parser.add_argument("--repo", help="which repository this checkout is (default: detected by marker file)")
    parser.add_argument("--update", action="store_true", help="re-record the sha256 of this checkout's files")
    parser.add_argument("--root", type=Path, default=ROOT, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    try:
        if args.update:
            return update(args.root, args.repo)
        results, names = run(args.root, args.repo, args.sibling)
    except ManifestError as error:
        print(f"::error::{error}" if os.environ.get("GITHUB_ACTIONS") == "true" else error, file=sys.stderr)
        return 2
    return report(results, names, args.sibling is not None)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
