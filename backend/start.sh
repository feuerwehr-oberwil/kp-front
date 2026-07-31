#!/usr/bin/env bash
# Apply migrations (with a pre-migration safety dump), then start the API (which also
# serves the SPA in prod).
set -euo pipefail

# Pre-migration safety net: when a migration is actually pending, dump the DB first so a bad
# migration is recoverable without external backups.
#
# This used to be best-effort — a failed dump warned and continued, "because a 3am hotfix must
# still boot". That reasoning hid a total outage of the safety net: the image pinned pg_dump to
# the *compose* server major (16) while Railway production runs 18.x, and pg_dump refuses to
# dump a server newer than itself. So every production migration ran with no dump whatsoever
# and printed one warning line nobody was reading. A net that fails silently is worse than no
# net, because you plan around having it.
#
# Now a pending migration with no usable dump ABORTS the boot. The hotfix path stays open where
# it is harmless: a plain restart with nothing pending never enters this block at all. To
# override deliberately and accept the risk, set ALLOW_MIGRATION_WITHOUT_BACKUP=1.
BACKUP_DIR="${MIGRATION_BACKUP_DIR:-${MEDIA_STORAGE_DIR:-data/storage}/backups}"

abort_or_override() {
  if [ "${ALLOW_MIGRATION_WITHOUT_BACKUP:-0}" = "1" ]; then
    echo "⚠ $1" >&2
    echo "⚠ ALLOW_MIGRATION_WITHOUT_BACKUP=1 set — migrating WITHOUT a safety dump, as instructed." >&2
    return 0
  fi
  echo "✖ $1" >&2
  echo "✖ Refusing to migrate without a pre-migration dump — this is the net that makes a bad" >&2
  echo "✖ migration recoverable. Fix the cause above, or set ALLOW_MIGRATION_WITHOUT_BACKUP=1" >&2
  echo "✖ to override deliberately." >&2
  exit 1
}

if [ -n "${DATABASE_URL:-}" ]; then
  current="$(uv run alembic current 2>/dev/null | grep -oE '^[0-9a-f]+' | sort | tr '\n' ',' || true)"
  head="$(uv run alembic heads 2>/dev/null | grep -oE '^[0-9a-f]+' | sort | tr '\n' ',' || true)"
  if [ "$current" != "$head" ]; then
    # pg_dump speaks postgresql://, not SQLAlchemy's postgresql+asyncpg:// driver URL.
    dump_url="${DATABASE_URL/+asyncpg/}"
    if ! command -v pg_dump >/dev/null; then
      abort_or_override "pg_dump is not present in this image."
    else
      # The mismatch that bit twice. The client major must be >= the SERVER major, and the
      # server is precisely the part that moves without anyone touching this image — a managed
      # host upgrading Postgres under you is not a hypothetical, it is what happened here.
      server="$(psql "$dump_url" -Atqc 'SHOW server_version' 2>/dev/null | cut -d. -f1 || true)"
      client="$(pg_dump --version 2>/dev/null | awk '{print $3}' | cut -d. -f1 || true)"
      # Both must be numeric before comparing: `[ "" -lt 18 ]` is not false, it is a fatal
      # "integer expression expected" under `set -e`, which would turn an unreadable version
      # string into a failed boot with an error pointing nowhere near the cause. If either
      # side is unknown, skip the guard and let the dump itself fail loudly below.
      if [ -n "$server" ] && [ -n "$client" ] && [ "$client" -lt "$server" ]; then
        abort_or_override "pg_dump $client cannot dump a Postgres $server server — rebuild the image with PG_CLIENT_MAJOR=$server."
      elif ! mkdir -p "$BACKUP_DIR" 2>/dev/null; then
        # A root-owned volume mount (e.g. Railway /mnt/data) makes this fail for the app user.
        abort_or_override "cannot create backup dir $BACKUP_DIR."
      else
        f="$BACKUP_DIR/pre-migrate-$(date +%Y%m%d-%H%M%S).sql.gz"
        echo "→ pending migration (${current:-<empty>} → ${head:-?}) — dumping DB to $f"
        # Write to .part and rename only after the gzip stream verifies. Two reasons: a crash
        # mid-dump can't leave a truncated file that looks valid, and the retention glob below
        # never counts a partial as one of the "newest 5" — which is how a directory of
        # fragments ends up rotating away the last good backup.
        if pg_dump "$dump_url" | gzip > "$f.part" && [ -s "$f.part" ] && gzip -t "$f.part" 2>/dev/null; then
          mv "$f.part" "$f"
          # keep the newest 5 pre-migration dumps
          ls -1t "$BACKUP_DIR"/pre-migrate-*.sql.gz 2>/dev/null | tail -n +6 | xargs -r rm -f --
        else
          rm -f "$f.part"
          abort_or_override "pre-migration dump failed or produced an unreadable file."
        fi
      fi
    fi
  fi
fi

uv run alembic upgrade head
exec uv run uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}"
