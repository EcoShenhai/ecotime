// Configuration from EcoTime's own settings only, validated at start (§13.1). A machine-wide DATABASE_URL is never
// read; ECOTIME_DATABASE_URL is the only override of the DB_* settings. Values are never printed.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
export const BACKEND_ROOT = path.resolve(here, '../..');
if (!process.env.ECOTIME_SKIP_DOTENV) dotenv.config({ path: process.env.ECOTIME_ENV_FILE || path.join(BACKEND_ROOT, '.env'), quiet: true, override: true });

const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
const bool = (v) => String(v).toLowerCase() === 'true';
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

function dbFrom(env) {
  if (env.ECOTIME_DATABASE_URL) {
    const u = new URL(env.ECOTIME_DATABASE_URL);
    return { host: u.hostname, port: Number(u.port || 5432), name: u.pathname.slice(1), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
      ssl: u.searchParams.get('sslmode') ? u.searchParams.get('sslmode') !== 'disable' : bool(env.DB_SSL) };
  }
  return { host: env.DB_HOST, port: Number(env.DB_PORT), name: env.DB_NAME, user: env.DB_USER, password: env.DB_PASSWORD, ssl: bool(env.DB_SSL) };
}

export function loadConfig(env = process.env) {
  const db = dbFrom(env);
  const missing = ['PORT', 'ECOID_ISSUER', 'PUBLIC_BASE_URL', 'SESSION_JWT_SECRET', 'REFRESH_TOKEN_PEPPER', 'DATA_KEY'].filter((k) => !env[k]);
  if (!db.host || !db.name || !db.user || !db.password) missing.push('DB_* (or ECOTIME_DATABASE_URL)');
  if (missing.length) throw new Error(`Missing settings: ${missing.join(', ')}`);
  if (!/^[0-9a-f]{64}$/i.test(env.DATA_KEY)) throw new Error('DATA_KEY must be 64 hex characters');
  if (env.SESSION_JWT_SECRET.length < 32 || env.REFRESH_TOKEN_PEPPER.length < 32) throw new Error('SESSION_JWT_SECRET and REFRESH_TOKEN_PEPPER must be at least 32 characters');
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('NODE_TLS_REJECT_UNAUTHORIZED=0 is forbidden in EcoTime (F5)');
  return Object.freeze({
    env: env.NODE_ENV || 'production',
    foreignDatabaseUrl: Boolean(env.DATABASE_URL),
    port: Number(env.PORT), bindHost: env.BIND_HOST || '127.0.0.1', trustProxy: 1,
    appCode: env.SUPPORT_APP_CODE || 'ECOTIME', ticketPrefix: env.SUPPORT_TICKET_PREFIX || 'ETM-',
    publicBaseUrl: env.PUBLIC_BASE_URL.replace(/\/+$/, ''), corsOrigins: list(env.CORS_ORIGIN),
    db: { ...db, sslCaFile: env.DB_SSL_CA || '', poolMax: num(env.DB_POOL_MAX, 5) },
    ecoid: { issuer: env.ECOID_ISSUER.replace(/\/+$/, ''), audiences: list(env.ECOID_AUDIENCE || 'ecotime,ecotime-mobile'), allowNoAudience: bool(env.ECOID_ALLOW_NO_AUDIENCE) },
    jwtSecret: env.SESSION_JWT_SECRET, refreshPepper: env.REFRESH_TOKEN_PEPPER, dataKey: Buffer.from(env.DATA_KEY, 'hex'),
    session: { accessTtlMin: num(env.ACCESS_TTL_MIN, 15), refreshTtlDays: num(env.REFRESH_TTL_DAYS, 30), adminAccessTtlMin: 10, adminRefreshTtlHours: 12 },
    admin: { maxFailures: num(env.ADMIN_MAX_FAILURES, 5), lockMinutes: num(env.ADMIN_LOCK_MINUTES, 15) },
    clock: { stateFile: env.CLOCK_STATE_FILE || '/var/lib/ecotime-collector/clock-state.json', hostLabel: env.CLOCK_HOST_LABEL || 'ecocloud-prod-01',
      maxAgeS: num(env.CLOCK_OBSERVATION_MAX_AGE_SECONDS, 120), offsetWarnMs: num(env.CLOCK_OFFSET_WARN_MS, 50), rootDistanceWarnMs: num(env.CLOCK_ROOT_DISTANCE_WARN_MS, 250),
      requireDiversity: bool(env.CLOCK_REQUIRE_SOURCE_DIVERSITY), tzdataFile: env.TZDATA_VERSION_FILE || '/usr/share/zoneinfo/tzdata.zi', zoneTab: env.ZONE_TAB_FILE || '/usr/share/zoneinfo/zone1970.tab' },
    scheduler: { leaseMs: num(env.SCHEDULER_LEASE_MS, 60000), batch: num(env.SCHEDULER_BATCH_SIZE, 20), pollMs: num(env.SCHEDULER_POLL_MS, 5000), maxAttempts: num(env.SCHEDULER_MAX_ATTEMPTS, 4),
      actionTimeoutMs: num(env.SCHEDULER_ACTION_TIMEOUT_MS, 10000), workerId: env.SCHEDULER_WORKER_ID || '' },
    limits: { minIntervalMin: num(env.SCHEDULE_MIN_INTERVAL_MINUTES, 5), emailMinIntervalMin: num(env.SCHEDULE_EMAIL_MIN_INTERVAL_MINUTES, 60), horizonDays: num(env.SCHEDULE_MAX_HORIZON_DAYS, 3650), previewMax: num(env.SCHEDULE_PREVIEW_MAX, 50) },
    webhooks: { allowedDomains: list(env.WEBHOOK_ALLOWED_DOMAINS || 'eshcloud.com,theshenhai.com') },
    smtp: { host: env.SMTP_HOST, port: num(env.SMTP_PORT, 2525), secure: bool(env.SMTP_SECURE), user: env.SMTP_USER, password: env.SMTP_PASSWORD,
      fromEmail: env.SMTP_FROM_EMAIL || 'noreply@time.eshcloud.com', fromName: env.SMTP_FROM_NAME || 'Shenhai EcoTime' },
    supportEmail: env.SUPPORT_EMAIL || 'support@theshenhai.com',
    rateLimit: { windowMs: num(env.RATE_LIMIT_WINDOW, 60000), max: num(env.RATE_LIMIT_MAX_REQUESTS, 300) },
  });
}
