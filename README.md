# Shenhai EcoTime

The time layer of Shenhai B2X: one trusted clock with honest health, correct IANA time-zone conversion, and durable
schedules that run once and on time across daylight-saving changes (EcoTime Master Reference v1.0).

**Live:** https://time.eshcloud.com · API `/api/v1` · PM2 `ecotime-backend` (port 4027) and `ecotime-scheduler` ·
database `ecotime_db` (PostgreSQL 18), role `ecotime_user` · systemd `ecotime-collector.timer`

## What version 1 does
- **Clock health, measured not assumed (T5, §9):** a read-only collector (own system user `ecotime-collector`, systemd timer, every 30 s) reads
  systemd-timesyncd and writes `/var/lib/ecotime-collector/clock-state.json`. EcoTime reports `synchronized`,
  `degraded`, `unsynchronized`, `stale` or `unknown` with the reason, offset, root distance, source and age. Clock steps
  are detected from wall-clock versus monotonic progress. EcoTime never sets the clock (T6).
- **Every response** carries `X-EcoTime-Server-Time` and `X-EcoTime-Clock-Status`. `/metrics` (Prometheus text) answers
  only on loopback and is not proxied by nginx.
- **Time zones:** IANA names only (fixed offsets are refused); aliases such as `Asia/Kolkata` accepted. Local → instant
  conversion reports `unique`, `ambiguous` (fall back) or `nonexistent` (spring forward) with the policy applied.
  Runtime and OS tz rule versions are compared and a mismatch is recorded (finding F4).
- **Durable schedules (§10):** the intent (local time + zone + RRULE) is stored; each instant is computed from it, so
  09:00 stays 09:00 through DST. Workers claim due jobs with `FOR UPDATE SKIP LOCKED` leases timed by the database
  clock; each occurrence has one idempotency key `sha256(scheduleId|scheduledFor)`, so a crashed or racing worker can
  never run it twice. Retries back off 30 s · 2ⁿ⁻¹ up to the limit, then the occurrence is failed and the schedule moves on.
  Actions: record, email, or HMAC-signed webhook (approved HTTPS domains only). When the runtime tz rules change,
  future instants are recomputed from the intent.
- **Callers:** people (EcoID, PKCE; a personal organization is created at first sign-in), operators (password + Shenhai
  Authenticator; EcoID admin accounts are refused), other B2X apps (`etk_` keys bound to one organization, scoped
  `time:read`, `time:convert`, `schedules:read`, `schedules:write`). Organizations cannot see each other's schedules.
- **Console:** Now (server clock, device skew from the round trip, health), Convert, Schedules (preview, create with
  Idempotency-Key, pause/resume/cancel, run history), Time zones by territory, Settings, Support (`ETM-` references);
  operators: Clock & sources, Organizations, API keys, Webhooks, All schedules, People, Activity (append-only audit).
  72 languages (71 English placeholders), right-to-left, dark mode, strict CSP.

## Known limits
- **F1 single upstream source:** the droplet's timesyncd uses `ntp.ubuntu.com` only; EcoTime shows this as
  `single_source`. Adding independent (ideally NTS) sources is a host change outside this app.
- **F4 rule versions:** Node's bundled tz rules can lag the OS tzdata. EcoTime calculates with the runtime rules and
  shows the mismatch; upgrade Node to pick up newer rules.
- EcoBus events wait for the shared EcoBus client; the Capacitor store app waits for the mobile phase.

## Commands
```
npm ci && npm run build -w frontend
npm test -w backend                                                     # unit tests
TEST_DB_NAME=ecotime_test npm run test:integration -w backend           # needs PostgreSQL
cd backend && node scripts/migrate.js                                   # ledger migrations
cd backend && node scripts/seed.js --registry <CPAMind registry.json>   # languages, territories + zones, sources
cd backend && node scripts/admin.js create <email>                      # operator (password + Authenticator)
cd backend && node scripts/check.js                                     # pre-start gate
node backend/scripts/collect-clock.js /tmp/clock-state.json             # one collector sample by hand
```
API contract: `shared/api-contracts/ecotime.v1.yaml`. Secrets live only in `backend/.env` (mode 600); see `backend/.env.example`.
