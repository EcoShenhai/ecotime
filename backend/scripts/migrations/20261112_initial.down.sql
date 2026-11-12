-- Reverses 20261112_initial.sql.
DROP TABLE IF EXISTS support_tickets, retention_policies, audit_events, idempotency_keys, schedule_executions, scheduled_jobs, webhook_endpoints,
  time_zone_preferences, time_zone_rulesets, clock_health_events, clock_observations, time_sources, api_credentials, api_clients,
  auth_sessions, admins, organization_members, users, organizations, territories, languages CASCADE;
DROP FUNCTION IF EXISTS audit_events_append_only();
DELETE FROM schema_migrations WHERE filename = '20261112_initial.sql';
