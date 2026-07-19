#!/usr/bin/env bash
# Apply migrations (with a pre-migration safety dump), then start the API (which also
# serves the SPA in prod).
set -euo pipefail

# Pre-migration safety net: when a migration is actually pending and pg_dump is available,
# dump the DB first so a bad migration is recoverable without external backups. Best-effort
# by design — a failed DUMP warns and continues (a 3am hotfix must still boot), while a
# failed MIGRATION still aborts the start (set -e).
BACKUP_DIR="${MIGRATION_BACKUP_DIR:-${MEDIA_STORAGE_DIR:-data/storage}/backups}"
if command -v pg_dump >/dev/null && [ -n "${DATABASE_URL:-}" ]; then
  current="$(uv run alembic current 2>/dev/null | grep -oE '^[0-9a-f]+' | sort | tr '\n' ',' || true)"
  head="$(uv run alembic heads 2>/dev/null | grep -oE '^[0-9a-f]+' | sort | tr '\n' ',' || true)"
  if [ "$current" != "$head" ]; then
    # mkdir must be best-effort too: a root-owned volume mount (e.g. Railway /mnt/data)
    # makes it fail for the non-root app user, and that must not block the boot.
    if ! mkdir -p "$BACKUP_DIR" 2>/dev/null; then
      echo "⚠ cannot create backup dir $BACKUP_DIR — skipping pre-migration dump, fix your backups" >&2
    else
      f="$BACKUP_DIR/pre-migrate-$(date +%Y%m%d-%H%M%S).sql.gz"
      echo "→ pending migration (${current:-<empty>} → ${head:-?}) — dumping DB to $f"
      # pg_dump speaks postgresql://, not SQLAlchemy's postgresql+asyncpg:// driver URL.
      if pg_dump "${DATABASE_URL/+asyncpg/}" | gzip > "$f"; then
        # keep the newest 5 pre-migration dumps
        ls -1t "$BACKUP_DIR"/pre-migrate-*.sql.gz 2>/dev/null | tail -n +6 | xargs -r rm -f --
      else
        rm -f "$f"
        echo "⚠ pre-migration dump failed — continuing, but fix your backups" >&2
      fi
    fi
  fi
fi

uv run alembic upgrade head
exec uv run uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}"
