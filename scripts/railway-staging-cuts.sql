-- ─── staging cuts (railway-staging-refresh.sh) ───
-- Run in the same transaction as the restore of prod's dump into staging. Every path by which a
-- copy of prod reaches real people or prod's own systems is cut here; see the script's header.
-- __STAGING_APP_NAME__ is replaced by the script with a JSON string. backend/tests/
-- test_staging_refresh_cuts.py runs this file against PostgreSQL.
SET search_path = public;  -- the dump emptied it
TRUNCATE push_subscriptions, print_jobs;
-- sharepoint_export_*: the Einsatz-Ablage's and the Objektbesuche delivery's WRITE registration
-- (hunt 24.11.2026, ops-integrations F1). The read-only SharePoint feed has its own credentials
-- and stays.
DELETE FROM integration_credentials WHERE name IN (
  'healthcheck_ping_url', 'print_agent_secret', 'alarm_webhook_secret', 'divera_webhook_secret',
  'vapid_public_key', 'vapid_private_key', 'vapid_subject',
  'sharepoint_export_tenant_id', 'sharepoint_export_client_id', 'sharepoint_export_client_secret');
-- …and the destinations they wrote to: prod's archive library and Objektbesuche folders. A copied
-- pending delivery then pauses (no destination) instead of writing into prod's SharePoint.
UPDATE deployment_config SET config_json =
  jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(coalesce(config_json, '{}'::jsonb), '{identity}',
                  coalesce(config_json->'identity', '{}'::jsonb) || jsonb_build_object('appName', '__STAGING_APP_NAME__'::jsonb)),
        '{alarms}', coalesce(config_json->'alarms', '{}'::jsonb) || '{"webhooks": []}'::jsonb),
      '{incidentArchive}', coalesce(config_json->'incidentArchive', '{}'::jsonb) || '{"destinations": []}'::jsonb),
    '{objectVisits}', coalesce(config_json->'objectVisits', '{}'::jsonb) || '{"destinations": []}'::jsonb);
