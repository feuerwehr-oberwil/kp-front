#!/usr/bin/env python3
"""List — and with --apply, remove — git worktrees and local branches that are done.

`just wt-prune` (read-only) / `just wt-prune --apply`. Run from anywhere inside the repo.

A worktree or branch is DONE when its tip is merged into origin/main, or its pull request is
merged (a squash merge leaves the tip off main, so the PR is the only record). A PR that was
closed without merging is listed as `closed` and only removed with --closed.

--apply removes only what is done AND safe to lose:
  · clean: no modified or untracked file (`git status`), and no ignored file outside the
    rebuildable caches (node_modules, dist, .venv, …) — `tmp/`, `.env`, `backend/private/` or
    `docs/planning/` in a worktree can be the only copy of something;
  · pushed: the tip is on origin/main, IS the PR's head, or is on some remote branch — a local
    commit made after the PR merged is never thrown away;
  · idle: nothing committed or checked out there for --min-age hours (default 24);
  · not in use: no running process has its working directory inside it;
  · not kept: the primary checkout, the worktree you run this from, main/staging, and any name
    matching a --keep glob (repeatable; matched against the branch AND the directory name).

Everything else is listed with the reason it stays. Nothing is fetched unless --fetch is
given; the PR states come from `gh` (without it, only the merged-into-main test applies).
"""

# ruff: noqa: S603, S607 — every argv is git/gh/lsof plus this script's own literals and git's output

from __future__ import annotations

import argparse
import contextlib
import fnmatch
import json
import os
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

PROTECTED_BRANCHES = {"main", "master", "staging"}
# Ignored paths that are rebuilt by a command and never anybody's only copy.
REBUILDABLE = (
    "node_modules",
    ".venv",
    "dist",
    "dev-dist",
    "coverage",
    "__pycache__",
    ".ruff_cache",
    ".mypy_cache",
    ".pytest_cache",
    ".vite",
    "test-results",
    "playwright-report",
    "blob-report",
    "perf-results",
    ".pnpm-store",
    "site/dist",
    ".next",  # KP Rück's frontend — the script works on any repo
    ".turbo",
)
REBUILDABLE_SUFFIXES = (".pyc", ".tsbuildinfo", ".log", "next-env.d.ts")


def git(*args: str, cwd: str | Path | None = None, check: bool = True) -> str:
    out = subprocess.run(["git", "--no-optional-locks", *args], cwd=cwd, capture_output=True, text=True, check=False)
    if check and out.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)}: {out.stderr.strip()}")
    return out.stdout.strip() if out.returncode == 0 else ""


def ok(*args: str, cwd: str | Path | None = None) -> bool:
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, check=False).returncode == 0


@dataclass
class Item:
    kind: str  # "worktree" | "branch"
    branch: str  # "" for a detached worktree
    path: str = ""
    tip: str = ""
    age_h: float = 0.0
    state: str = ""  # merged | pr-merged | closed | open | unmerged
    pr: int | None = None
    dirty: str = ""  # "" = clean, else what makes it dirty
    reasons: list[str] = field(default_factory=list)

    @property
    def name(self) -> str:
        return Path(self.path).name if self.path else self.branch


def pr_states(repo_root: str) -> dict[str, dict]:
    """head branch → newest PR on it (state, number, headRefOid)."""
    if not shutil.which("gh"):
        return {}
    out = subprocess.run(
        ["gh", "pr", "list", "--state", "all", "--limit", "2000", "--json", "headRefName,state,number,headRefOid"],
        cwd=repo_root,
        capture_output=True,
        text=True,
        check=False,
    )
    if out.returncode != 0:
        print(f"⚠ gh pr list failed ({out.stderr.strip()[:120]}) — PR states unknown", file=sys.stderr)
        return {}
    by_branch: dict[str, dict] = {}
    for pr in json.loads(out.stdout):
        cur = by_branch.get(pr["headRefName"])
        if cur is None or pr["number"] > cur["number"]:
            by_branch[pr["headRefName"]] = pr
    return by_branch


def process_cwds() -> list[str]:
    cwds = []
    for proc in Path("/proc").glob("[0-9]*"):
        try:
            cwds.append(os.readlink(proc / "cwd"))
        except OSError:
            continue
    if not cwds and shutil.which("lsof"):  # macOS has no /proc
        out = subprocess.run(["lsof", "-d", "cwd", "-Fn"], capture_output=True, text=True, check=False)
        cwds = [line[1:] for line in out.stdout.splitlines() if line.startswith("n")]
    return cwds


def local_only_ignored(path: str, disposable: list[str]) -> list[str]:
    """Ignored files that are NOT a rebuildable cache — possibly somebody's only copy.

    Walks the tree itself, skipping the caches, and subtracts what git tracks: on a clean
    worktree whatever is left is ignored. (`git status --ignored` answers the same question but
    descends into node_modules to do it — 15 s per worktree, half an hour for a hundred.)
    """
    tracked = set(git("ls-files", "-z", cwd=path, check=False).split("\0"))
    found: list[str] = []
    root = Path(path)
    for dirpath, dirnames, filenames in os.walk(path):
        rel_dir = Path(dirpath).relative_to(root).as_posix()
        dirnames[:] = [
            d
            for d in dirnames
            if d != ".git" and d not in REBUILDABLE and f"{rel_dir}/{d}".removeprefix("./") not in REBUILDABLE
        ]
        for name in filenames:
            rel = f"{rel_dir}/{name}".removeprefix("./")
            if name == ".git" or rel in tracked or rel.endswith(REBUILDABLE_SUFFIXES):
                continue
            if any(fnmatch.fnmatch(rel, g) for g in disposable):
                continue
            found.append(rel)
            if len(found) >= 20:
                return found
    return found


def last_touched(path: str, tip_time: float) -> float:
    """Newest of the tip's commit time and the last HEAD reflog entry (commit, checkout, reset).

    The entry's own timestamp, not a file's mtime: a plain `git status` rewrites the index, and
    housekeeping rewrites the reflog files, so either would make every worktree look fresh. On a
    clean tree the commits are the only work there is to lose.
    """
    newest = tip_time
    p = git("rev-parse", "--git-path", "logs/HEAD", cwd=path, check=False)
    full = Path(p) if p and os.path.isabs(p) else Path(path) / p if p else None
    if full and full.exists():
        lines = full.read_text(errors="replace").splitlines()
        if lines:
            # "<old> <new> Name <email> <epoch> <tz>\t<message>"
            with contextlib.suppress(ValueError, IndexError):
                newest = max(newest, float(lines[-1].split("\t", 1)[0].rsplit(" ", 2)[-2]))
    return newest


def on_a_remote(tip: str, cwd: str) -> bool:
    return bool(git("branch", "-r", "--contains", tip, cwd=cwd, check=False))


def classify(item: Item, prs: dict[str, dict], cwd: str) -> None:
    if item.tip and ok("merge-base", "--is-ancestor", item.tip, "origin/main", cwd=cwd):
        item.state = "merged"
        return
    pr = prs.get(item.branch)
    if pr:
        item.pr = pr["number"]
        if pr["state"] == "MERGED":
            item.state = "pr-merged"
        elif pr["state"] == "CLOSED":
            item.state = "closed"
        else:
            item.state = "open"
        if item.state in ("pr-merged", "closed") and item.tip != pr["headRefOid"] and not on_a_remote(item.tip, cwd):
            item.reasons.append("has commits that were never pushed")
        return
    item.state = "unmerged"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true", help="remove what is done and safe (default: list only)")
    ap.add_argument("--closed", action="store_true", help="also remove branches whose PR was closed unmerged")
    ap.add_argument("--min-age", type=float, default=24, help="hours untouched before removal (default 24)")
    ap.add_argument("--keep", action="append", default=[], metavar="GLOB", help="never remove a matching name")
    ap.add_argument(
        "--disposable",
        action="append",
        default=[],
        metavar="GLOB",
        help="ignored files matching this are not worth keeping (e.g. 'backend/data/storage/*')",
    )
    ap.add_argument("--fetch", action="store_true", help="git fetch --prune first")
    ap.add_argument("--all", action="store_true", help="also list what is still in progress")
    args = ap.parse_args()

    here = os.getcwd()
    common = Path(git("rev-parse", "--path-format=absolute", "--git-common-dir"))
    primary = str(common.parent)
    current = git("rev-parse", "--show-toplevel")
    if args.fetch:
        git("fetch", "--prune", "--quiet", cwd=primary)
    if not git("rev-parse", "--verify", "--quiet", "origin/main", cwd=primary, check=False):
        print("no origin/main — fetch first (--fetch)", file=sys.stderr)
        return 2

    prs = pr_states(primary)
    cwds = process_cwds()
    now = time.time()
    items: list[Item] = []

    # --- worktrees ---------------------------------------------------------------------
    porcelain = git("worktree", "list", "--porcelain", cwd=primary)
    wt_branches: set[str] = set()
    for block in porcelain.split("\n\n"):
        fields = dict(line.split(" ", 1) if " " in line else (line, "") for line in block.splitlines())
        path = fields.get("worktree", "")
        if not path or path == primary:
            continue
        branch = fields.get("branch", "").removeprefix("refs/heads/")
        wt_branches.add(branch)
        item = Item("worktree", branch, path=path, tip=fields.get("HEAD", ""))
        tip_time = float(git("log", "-1", "--format=%ct", item.tip, cwd=primary, check=False) or 0)
        if "prunable" in fields or not Path(path).exists():
            # The directory is already gone; only git's record of it is left (and the branch).
            item.age_h = (now - tip_time) / 3600
            classify(item, prs, primary)
            item.reasons.append("directory already deleted — `git worktree prune` clears the record")
            items.append(item)
            continue
        item.age_h = (now - last_touched(path, tip_time)) / 3600
        status = git("status", "--porcelain", cwd=path, check=False)
        if status:
            n = len(status.splitlines())
            item.dirty = f"{n} uncommitted/untracked"
        else:
            extra = local_only_ignored(path, args.disposable)
            if extra:
                item.dirty = f"ignored local files: {', '.join(extra[:3])}{' …' if len(extra) > 3 else ''}"
        classify(item, prs, primary)
        if path == current or here.startswith(path + os.sep) or here == path:
            item.reasons.append("you are in it")
        if any(c == path or c.startswith(path + os.sep) for c in cwds):
            item.reasons.append("a process runs in it")
        items.append(item)

    # --- local branches without a worktree --------------------------------------------
    refs = git(
        "for-each-ref", "--format=%(refname:short) %(objectname) %(committerdate:unix)", "refs/heads", cwd=primary
    )
    primary_branch = git("branch", "--show-current", cwd=primary, check=False)
    for line in refs.splitlines():
        branch, tip, ts = line.split(" ")
        if branch in wt_branches or branch == primary_branch:
            continue
        item = Item("branch", branch, tip=tip, age_h=(now - float(ts)) / 3600)
        classify(item, prs, primary)
        items.append(item)

    # --- decide ------------------------------------------------------------------------
    removable_states = {"merged", "pr-merged"} | ({"closed"} if args.closed else set())
    for item in items:
        if item.branch in PROTECTED_BRANCHES:
            item.reasons.append("protected branch")
        if any(fnmatch.fnmatch(n, g) for g in args.keep for n in (item.branch, item.name) if n):
            item.reasons.append("--keep")
        if item.state not in removable_states:
            item.reasons.append(
                {"closed": "PR closed unmerged (--closed)", "open": f"PR #{item.pr} open"}.get(item.state, "not merged")
            )
        if item.dirty:
            item.reasons.append(item.dirty)
        if item.age_h < args.min_age:
            item.reasons.append(f"touched {item.age_h:.0f} h ago")

    done = [i for i in items if i.state in removable_states | {"closed"}]
    go = [i for i in done if not i.reasons]
    stay = [i for i in done if i.reasons]
    rest = [i for i in items if i not in done]

    def row(i: Item) -> str:
        pr = f"#{i.pr}" if i.pr else ""
        where = i.path.replace(str(Path.home()), "~") if i.path else "(branch only)"
        why = "; ".join(i.reasons)
        return f"  {i.kind:8} {i.branch or '(detached)':40.40} {i.state:9} {pr:6} {i.age_h:6.0f}h  {where}" + (
            f"\n{'':12}↳ stays: {why}" if why else ""
        )

    print(f"{len(go)} to remove{'' if args.apply else ' (dry run — add --apply)'}:")
    for i in go:
        print(row(i))
    if stay:
        print(f"\n{len(stay)} done but kept:")
        for i in stay:
            print(row(i))
    if args.all and rest:
        print(f"\n{len(rest)} in progress:")
        for i in rest:
            print(row(i))
    elif rest:
        print(f"\n{len(rest)} still in progress (--all lists them)")

    if not args.apply:
        return 0
    failed = 0
    for i in go:
        if i.kind == "worktree" and not ok("worktree", "remove", i.path, cwd=primary):
            print(f"✗ could not remove {i.path}", file=sys.stderr)
            failed += 1
            continue
        if i.branch and i.branch not in PROTECTED_BRANCHES and not ok("branch", "-D", i.branch, cwd=primary):
            print(f"✗ could not delete branch {i.branch}", file=sys.stderr)
            failed += 1
    ok("worktree", "prune", cwd=primary)  # records of directories deleted by hand
    print(f"\nremoved {len(go) - failed}, failed {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
