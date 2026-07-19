# Backup/restore drill — 2026-07-02

**Result: PASS.** The production database is provably recoverable into a fresh stack; every
incident's audit hash chain verifies intact after restore.

## What was done

1. **Dump** the production Postgres (Railway, `postgres-ssl:18`) read-only via the public proxy URL.
   Local `pg_dump` 14 is too old for a v18 server, so the dump ran from a `postgres:18` container:

   ```bash
   URL=$(railway variables --service Postgres --json | jq -r '.DATABASE_PUBLIC_URL')
   docker run --rm postgres:18 pg_dump "$URL" --no-owner --no-privileges | gzip > prod-drill.sql.gz
   ```

2. **Restore** into a fresh, empty `postgres:18` container:

   ```bash
   docker run -d --name drill-pg -e POSTGRES_PASSWORD=… -e POSTGRES_DB=drill -p 5544:5432 postgres:18
   gunzip -c prod-drill.sql.gz | docker exec -i drill-pg psql -q -U postgres -d drill   # 0 errors
   ```

3. **Verify row counts** — identical to production across all checked tables:
   incidents 12 · incident_events 4565 · workspace_snapshots 1842 · users 4 · personnel 66 ·
   media 8 · objects 155 · reference_datasets 470.

4. **Boot the real backend** against the restored DB (`DATABASE_URL` → drill container, production
   `SECRET_KEY`, `SEED_DATABASE=false`): `/ready` reported `database: ok, storage: ok`, and the
   editor PIN verified against the restored hashes (proves the peppered-bcrypt auth round-trips).

5. **Verify the legal record**: `GET /api/incidents/{id}/verify` on **all 12** restored incidents →
   `intact: true, broken_at_seq: null` for every hash chain (largest: 997 events).

6. Teardown; the dump (real operational data) was deleted after the drill.

## Caveats / follow-ups

- **Media volume not drilled** — Railway volumes aren't reachable via CLI, so the storage half
  (8 media blobs) is covered only by the tooling (`scripts/backup.sh` tars it on self-hosted
  stacks) and by the missing-blob 404 handling (`backend/tests/test_media.py`). A prod media
  drill needs a shell on the Railway service or the next migration to a self-managed host.
- **Version note:** Railway production runs Postgres **18** while `docker-compose.yml` pins
  `postgres:16`. Dumps are portable (this drill restored an 18 dump into 18; a 16 target also
  accepts plain-SQL dumps), but keep `pg_dump`'s major ≥ the server's when dumping.
- Ongoing backups: `scripts/backup.sh` (self-hosted, cron) + the automatic pre-migration dump in
  `backend/start.sh`; for Railway, schedule `pg_dump` against `DATABASE_PUBLIC_URL` off-box.
