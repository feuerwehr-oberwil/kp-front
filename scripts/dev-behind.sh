#!/usr/bin/env bash
# The developer half of `just doctor` (08.10.2026): is THIS checkout far behind origin/main?
#
# A checkout weeks behind main looks perfectly healthy — it builds, its tests pass — and an agent
# or a person who starts work in it builds on code that no longer exists (the primary KP Rück
# checkout was 1,306 commits behind and fooled an agent that way). Warns only; never fetches,
# so the count is as of your last `git fetch`, and says how old that is.
#
# A station's copy is usually not a git checkout at all — then this says nothing.
set -u
git rev-parse --git-dir >/dev/null 2>&1 || exit 0
git rev-parse --verify -q origin/main >/dev/null || exit 0

limit=${KP_BEHIND_WARN:-50}
behind=$(git rev-list --count HEAD..origin/main)
branch=$(git branch --show-current)
fetch_head=$(git rev-parse --git-path FETCH_HEAD)
fetched=""
if [ -f "$fetch_head" ]; then
  days=$(( ( $(date +%s) - $(stat -c %Y "$fetch_head" 2>/dev/null || stat -f %m "$fetch_head") ) / 86400 ))
  [ "$days" -ge 1 ] && fetched=" (as of a fetch ${days} d ago — \`git fetch\` for today's number)"
fi

if [ "$behind" -ge "$limit" ]; then
  printf '\033[1;33m⚠ %s is %s commits behind origin/main%s.\033[0m\n' "${branch:-HEAD}" "$behind" "$fetched"
  printf '  New work starts from origin/main: git worktree add ../<name> -b <branch> origin/main\n'
  printf '  (or: git switch main && git pull --ff-only). KP_BEHIND_WARN=%s sets the threshold.\n\n' "$limit"
else
  printf '✓ %s is %s commits behind origin/main%s.\n' "${branch:-HEAD}" "$behind" "$fetched"
fi

n=$(git worktree list | wc -l)
if [ "$n" -gt 20 ]; then
  printf '  %s worktrees — `just wt-prune` lists the finished ones.\n\n' "$n"
fi
exit 0
