// EcoTime against a real PostgreSQL and a fake EcoID. Needs TEST_DB_NAME containing "test"; skipped otherwise.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { loadConfig } from '../../src/config/env.js';
import { createSequelize } from '../../src/db/index.js';
import { migrate } from '../../src/db/migrate.js';
import { createApp } from '../../src/app.js';
import { createEcoId } from '../../src/auth/ecoid.js';
import { hashPassword, seal, hotp, stepAt } from '../../src/auth/crypto.js';
import { createWorker, idempotencyKey } from '../../src/services/scheduling/worker.js';
import { createClockHealth } from '../../src/services/clock-health/index.js';
import { checkRuleset, purge } from '../../src/jobs/maintenance.js';
import { seed } from '../../scripts/seed.js';

const E = process.env;
const skip = !E.TEST_DB_NAME || !/test/.test(E.TEST_DB_NAME) ? 'TEST_DB_NAME (containing "test") not set' : false;
const ISS = 'https://ecoid.test';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ecotime-'));
const STATE = path.join(DIR, 'clock-state.json'); const TZFILE = path.join(DIR, 'tzdata.zi');
fs.writeFileSync(TZFILE, `# version ${process.versions.tz}\n`);
const cfg = skip ? null : loadConfig({ PORT: '0', DB_HOST: E.TEST_DB_HOST || '127.0.0.1', DB_PORT: E.TEST_DB_PORT || '5432', DB_NAME: E.TEST_DB_NAME, DB_USER: 'ecotime_user', DB_PASSWORD: 'x', DB_SSL: 'false',
  ECOID_ISSUER: ISS, PUBLIC_BASE_URL: 'https://time.eshcloud.com', CORS_ORIGIN: 'https://time.eshcloud.com', SESSION_JWT_SECRET: 'j'.repeat(48), REFRESH_TOKEN_PEPPER: 'p'.repeat(40),
  DATA_KEY: crypto.randomBytes(32).toString('hex'), RATE_LIMIT_MAX_REQUESTS: '100000', CLOCK_STATE_FILE: STATE, TZDATA_VERSION_FILE: TZFILE, SCHEDULER_MAX_ATTEMPTS: '2', SCHEDULER_LEASE_MS: '30000' });

let server, base, sequelize, eco, services;
const hooks = []; let hookStatus = 200;
const fakeFetch = async (url, init) => { hooks.push({ url, headers: init.headers, body: init.body }); return new Response('ok', { status: hookStatus }); };
const mails = [];
const ADMIN_SECRET = crypto.randomBytes(20); let stepOffset = 0;
const nextCode = () => hotp(ADMIN_SECRET, stepAt() - 1 + stepOffset++);
const ecoTok = (sub, extra = {}) => new SignJWT(extra).setProtectedHeader({ alg: 'ES256', kid: 'e1' }).setIssuer(ISS).setSubject(sub).setAudience('ecotime').setIssuedAt().setExpirationTime('5m').sign(eco);
const call = async (method, p, { token, body, headers = {} } = {}) => {
  const res = await fetch(base + p, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await res.text(); let json = null; try { json = t ? JSON.parse(t) : null; } catch { json = t; }
  return { status: res.status, json, headers: res.headers };
};
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.json)); return r.json; };
const err = (r, status, code) => { assert.equal(r.status, status, JSON.stringify(r.json)); assert.equal(r.json.error.code, code); return r.json.error; };
const writeState = (o) => fs.writeFileSync(STATE, JSON.stringify({ host: 'test', daemon: 'systemd-timesyncd', collectedAt: new Date().toISOString(), ntpSynchronized: true, offsetUs: -1589, rootDistanceUs: 23338, stratum: 2, server: 'ntp.ubuntu.com', ...o }));
const S = {};
const q = (sql, r = {}) => sequelize.query(sql, { replacements: r }).then(([x]) => x);
const makeDue = (id) => q(`UPDATE scheduled_jobs SET next_run_at = now() - interval '2 minutes' WHERE id = :id`, { id });

test.before(async () => {
  if (skip) return;
  const ek = await generateKeyPair('ES256'); eco = ek.privateKey;
  const ecoid = createEcoId({ issuer: ISS, audiences: cfg.ecoid.audiences, jwks: createLocalJWKSet({ keys: [{ ...(await exportJWK(ek.publicKey)), kid: 'e1', alg: 'ES256' }] }) });
  sequelize = createSequelize(cfg);
  await sequelize.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  assert.deepEqual(await migrate(sequelize), ['20261112_initial.sql']); assert.deepEqual(await migrate(sequelize), []);
  const registry = JSON.parse(fs.readFileSync(new URL('../fixtures/registry.json', import.meta.url), 'utf8'));
  const a = await seed(sequelize, registry, {}, () => {}); assert.deepEqual(a, await seed(sequelize, registry, {}, () => {}));
  const id = crypto.randomUUID();
  await q(`INSERT INTO admins (id, email, password_hash, totp_secret_enc) VALUES (:id, 'ops@example.com', :h, :s)`, { id, h: await hashPassword('correct horse battery staple'), s: seal(cfg.dataKey, ADMIN_SECRET.toString('base64url'), `admin-totp:${id}`) });
  writeState({});
  const app = createApp({ cfg, sequelize, ecoid, mailer: { enabled: true, send: async (m) => { mails.push(m); return true; } }, auditSalt: 's' });
  services = app.locals.services;
  server = app.listen(0, '127.0.0.1'); await new Promise((r) => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server?.close(); await sequelize?.close(); fs.rmSync(DIR, { recursive: true, force: true }); });

test('seed: territories carry their IANA zones; operators sign in with password + Authenticator', { skip }, async () => {
  const [ke] = await q(`SELECT time_zones FROM territories WHERE code = 'KE'`); assert.deepEqual(ke.time_zones, ['Africa/Nairobi']);
  const [us] = await q(`SELECT jsonb_array_length(time_zones) AS n FROM territories WHERE code = 'US'`); assert.ok(us.n > 20, 'several zones: the user must choose (§12.5)');
  S.admin = ok(await call('POST', '/api/v1/admin/auth/login', { body: { email: 'ops@example.com', password: 'correct horse battery staple', code: nextCode() } })).accessToken;
  err(await call('POST', '/api/v1/auth/ecoid/exchange', { body: { ecoidToken: await ecoTok('did:ecoid:global:user:root', { roles: ['admin'] }) } }), 403, 'ADMIN_NOT_ALLOWED');
  S.amina = ok(await call('POST', '/api/v1/auth/ecoid/exchange', { body: { ecoidToken: await ecoTok('did:ecoid:global:user:amina', { name: 'Amina' }) } })).accessToken;
  S.ben = ok(await call('POST', '/api/v1/auth/ecoid/exchange', { body: { ecoidToken: await ecoTok('did:ecoid:global:user:ben', { name: 'Ben' }) } })).accessToken;
  const me = ok(await call('GET', '/api/v1/me', { token: S.amina }));
  assert.equal(me.organizations.length, 1); assert.equal(me.organizations[0].kind, 'personal'); S.aminaOrg = me.organizations[0].id;
  err(await call('GET', '/api/v1/sources/status', { token: S.amina }), 403, 'ADMIN_ONLY');
});

test('time/now and headers report real clock state: synchronized, stale, unknown, unsynchronized (T5, §7.2, §7.4)', { skip }, async () => {
  writeState({});
  const n = await call('GET', '/api/v1/time/now', { token: S.amina });
  assert.equal(n.json.clockHealth.status, 'synchronized'); assert.equal(n.json.clockHealth.offsetMs, -1.589); assert.equal(n.json.clockHealth.daemon, 'systemd-timesyncd');
  assert.ok(Math.abs(Date.parse(n.headers.get('x-ecotime-server-time')) - Date.now()) < 5000); assert.equal(n.headers.get('x-ecotime-clock-status'), 'synchronized');
  assert.ok(n.json.requestId);
  writeState({ collectedAt: new Date(Date.now() - 10 * 60000).toISOString() }); await new Promise((r) => setTimeout(r, 2100));
  assert.equal(ok(await call('GET', '/api/v1/time/now', { token: S.amina })).clockHealth.status, 'stale');
  fs.rmSync(STATE); await new Promise((r) => setTimeout(r, 2100));
  const u = ok(await call('GET', '/api/v1/time/health', { token: S.amina }));
  assert.equal(u.clockHealth.status, 'unknown'); assert.equal(u.rulesets.agree, true);
  writeState({ ntpSynchronized: false }); await new Promise((r) => setTimeout(r, 2100));
  assert.equal((await call('GET', '/health/live')).headers.get('x-ecotime-clock-status'), 'unsynchronized');
  writeState({}); await new Promise((r) => setTimeout(r, 2100));
  assert.equal(ok(await call('GET', '/health/ready')).checks.clock, 'synchronized');
});

test('conversion: instants to zones and local times to instants, with DST resolution and ruleset (§7.3)', { skip }, async () => {
  const a = ok(await call('POST', '/api/v1/time/convert', { token: S.amina, body: { instant: '2026-10-22T12:30:00.000Z', timeZone: 'Africa/Nairobi' } }));
  assert.equal(a.localDateTime, '2026-10-22T15:30:00'); assert.equal(a.utcOffset, '+03:00'); assert.equal(a.rulesetVersion, process.versions.tz);
  const b = ok(await call('POST', '/api/v1/time/convert', { token: S.amina, body: { localDateTime: '2027-03-14T02:30:00', timeZone: 'America/New_York' } }));
  assert.deepEqual([b.resolution, b.policyApplied, b.instants], ['nonexistent', 'shift_forward', ['2027-03-14T07:30:00.000Z']]);
  const c = ok(await call('POST', '/api/v1/time/convert', { token: S.amina, body: { localDateTime: '2026-11-01T01:30:00', timeZone: 'America/New_York', dstOverlapPolicy: 'second' } }));
  assert.deepEqual([c.resolution, c.instants, c.candidates.length], ['ambiguous', ['2026-11-01T06:30:00.000Z'], 2]);
  err(await call('POST', '/api/v1/time/convert', { token: S.amina, body: { instant: '2026-10-22T12:30:00Z', timeZone: '+03:00' } }), 400, 'INVALID_TIME_ZONE');
  const z = ok(await call('GET', '/api/v1/time-zones/America/Argentina/Buenos_Aires', { token: S.amina })); assert.equal(z.currentOffset, '-03:00');
  assert.equal(ok(await call('GET', '/api/v1/time-zones/Africa/Nairobi', { token: S.amina })).observesDst, false);
  assert.ok(ok(await call('GET', '/api/v1/time-zones', { token: S.amina })).zones.length > 300);
  assert.equal(ok(await call('GET', '/api/v1/time-zones/version', { token: S.amina })).runtime, process.versions.tz);
});

test('operators: organization, webhook endpoint (secret once), scoped API key', { skip }, async () => {
  S.office = ok(await call('POST', '/api/v1/admin/organizations', { token: S.admin, body: { name: 'EcoOffice', kind: 'app' } }), 201).id;
  err(await call('POST', '/api/v1/admin/webhooks', { token: S.admin, body: { organizationId: S.office, name: 'x', url: 'https://evil.example/hook' } }), 400, 'INVALID_INPUT');
  const w = ok(await call('POST', '/api/v1/admin/webhooks', { token: S.admin, body: { organizationId: S.office, name: 'Reminders', url: 'https://office.eshcloud.com/hooks/ecotime' } }), 201);
  assert.match(w.secret, /^whsec_/); S.hook = w;
  const c = ok(await call('POST', '/api/v1/admin/api-clients', { token: S.admin, body: { organizationId: S.office, name: 'EcoOffice calendar', appCode: 'ECOOFFICE', scopes: ['time:read', 'time:convert', 'schedules:read', 'schedules:write'] } }), 201);
  S.officeKey = c.apiKey; assert.match(c.apiKey, /^etk_/);
  const r = ok(await call('POST', '/api/v1/admin/api-clients', { token: S.admin, body: { organizationId: S.office, name: 'Read only', appCode: 'ECOOFFICE', scopes: ['time:read'] } }), 201);
  S.readKey = r.apiKey;
  assert.equal(ok(await call('GET', '/api/v1/time/now', { token: S.readKey })).clockHealth.status, 'synchronized');
  err(await call('POST', '/api/v1/schedules/preview', { token: S.readKey, body: {} }), 403, 'SCOPE_MISSING');
  assert.ok(!JSON.stringify(ok(await call('GET', '/api/v1/admin/api-clients', { token: S.admin }))).includes(c.apiKey.split('_')[2]), 'the secret is never listed');
});

test('schedules: preview, create with Idempotency-Key, tenant isolation, limits (§7.1, §15.1-6)', { skip }, async () => {
  const intent = { name: 'Weekly team meeting', scheduleType: 'recurring', timeZone: 'Africa/Nairobi', startDate: '2026-11-16', localTime: '09:00', recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO' };
  const p = ok(await call('POST', '/api/v1/schedules/preview', { token: S.amina, body: { ...intent, count: 3 } }));
  assert.deepEqual(p.occurrences.map((o) => o.instant), ['2026-11-16T06:00:00.000Z', '2026-11-23T06:00:00.000Z', '2026-11-30T06:00:00.000Z']);
  err(await call('POST', '/api/v1/schedules/preview', { token: S.amina, body: { ...intent, recurrenceRule: 'FREQ=MINUTELY' } }), 400, 'INVALID_RECURRENCE');
  const body = { ...intent, actionType: 'record' };
  const c1 = await call('POST', '/api/v1/schedules', { token: S.amina, body, headers: { 'Idempotency-Key': 'create-meeting-0001' } });
  assert.equal(c1.status, 201); S.meeting = c1.json.id; assert.equal(c1.json.nextRunAt, '2026-11-16T06:00:00.000Z'); assert.equal(c1.json.upcoming.length, 5);
  const c2 = ok(await call('POST', '/api/v1/schedules', { token: S.amina, body, headers: { 'Idempotency-Key': 'create-meeting-0001' } }));
  assert.equal(c2.id, S.meeting); assert.equal(c2.replayed, true);
  err(await call('POST', '/api/v1/schedules', { token: S.amina, body: { ...body, name: 'Other' }, headers: { 'Idempotency-Key': 'create-meeting-0001' } }), 409, 'IDEMPOTENCY_MISMATCH');
  // another person, and another organization's key, cannot see it
  err(await call('GET', `/api/v1/schedules/${S.meeting}`, { token: S.ben }), 404, 'NOT_FOUND');
  err(await call('PATCH', `/api/v1/schedules/${S.meeting}`, { token: S.officeKey, body: { status: 'paused' } }), 404, 'NOT_FOUND');
  err(await call('POST', '/api/v1/schedules', { token: S.officeKey, body: { ...body, organizationId: S.aminaOrg } }), 404, 'NOT_FOUND');
  assert.equal(ok(await call('GET', '/api/v1/schedules', { token: S.ben })).length, 0);
  err(await call('POST', '/api/v1/schedules', { token: S.amina, body: { ...body, scheduleType: 'once', startDate: '2020-01-01', recurrenceRule: null } }), 400, 'INVALID_INPUT');
  err(await call('POST', '/api/v1/schedules', { token: S.amina, body: { ...body, actionType: 'webhook', webhookEndpointId: S.hook.id } }), 400, 'INVALID_INPUT'); // not her org's endpoint
  // pause / resume / version conflict
  const g = ok(await call('GET', `/api/v1/schedules/${S.meeting}`, { token: S.amina }));
  err(await call('PATCH', `/api/v1/schedules/${S.meeting}`, { token: S.amina, body: { status: 'paused', version: g.version - 1 } }), 409, 'VERSION_CONFLICT');
  assert.equal(ok(await call('PATCH', `/api/v1/schedules/${S.meeting}`, { token: S.amina, body: { status: 'paused', version: g.version } })).status, 'paused');
  assert.equal(ok(await call('PATCH', `/api/v1/schedules/${S.meeting}`, { token: S.amina, body: { status: 'active', localTime: '10:30' } })).nextRunAt, '2026-11-16T07:30:00.000Z', 'recomputed from the intent');
  // organization limit
  await q(`UPDATE organizations SET max_schedules = 1 WHERE id = :o`, { o: S.aminaOrg });
  err(await call('POST', '/api/v1/schedules', { token: S.amina, body: { ...body, name: 'Second' } }), 422, 'LIMIT_EXCEEDED');
  await q(`UPDATE organizations SET max_schedules = 500 WHERE id = :o`, { o: S.aminaOrg });
});

test('two workers race for the same due job: exactly one execution; signed webhook with idempotency key (§15.1-9)', { skip }, async () => {
  const s = ok(await call('POST', '/api/v1/schedules', { token: S.officeKey, body: { name: 'Daily digest', scheduleType: 'recurring', timeZone: 'Africa/Nairobi', startDate: '2026-11-12', localTime: '08:00',
    recurrenceRule: 'FREQ=DAILY', actionType: 'webhook', webhookEndpointId: S.hook.id, payload: { kind: 'digest' } } }), 201);
  S.digest = s.id; await makeDue(s.id);
  const [{ next_run_at: due }] = await q(`SELECT next_run_at FROM scheduled_jobs WHERE id = :id`, { id: s.id });
  const w1 = createWorker({ sequelize, cfg, fetchImpl: fakeFetch, workerId: 'w1' }); const w2 = createWorker({ sequelize, cfg, fetchImpl: fakeFetch, workerId: 'w2' });
  hooks.length = 0;
  const [r1, r2] = await Promise.all([w1.tick(), w2.tick()]);
  assert.equal([...r1, ...r2].filter((x) => x === 'succeeded').length, 1);
  const ex = await q(`SELECT status, attempt, lateness_ms FROM schedule_executions WHERE job_id = :id`, { id: s.id });
  assert.equal(ex.length, 1); assert.equal(ex[0].status, 'succeeded'); assert.ok(Number(ex[0].lateness_ms) >= 110000, 'lateness recorded, not hidden');
  assert.equal(hooks.length, 1);
  const h = hooks[0]; const [, ts, sig] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(h.headers['X-EcoTime-Signature']);
  assert.equal(sig, crypto.createHmac('sha256', S.hook.secret).update(`${ts}.${h.body}`).digest('hex'), 'HMAC signature verifies with the shown secret');
  assert.equal(h.headers['X-EcoTime-Idempotency-Key'], idempotencyKey(s.id, due));
  assert.equal(JSON.parse(h.body).payload.kind, 'digest');
  const [job] = await q(`SELECT next_run_at, lease_until, status FROM scheduled_jobs WHERE id = :id`, { id: s.id });
  assert.ok(new Date(job.next_run_at) > new Date()); assert.equal(job.lease_until, null); assert.equal(job.status, 'active');
  assert.equal((await w1.tick()).length, 0, 'nothing due any more');
});

test('a crashed worker: lease expires, another worker resumes once with the same key; retries then fail (§15.1-4)', { skip }, async () => {
  await makeDue(S.digest);
  const crashed = createWorker({ sequelize, cfg, fetchImpl: fakeFetch, workerId: 'crashed' });
  const [claimed] = await crashed.claim(); assert.equal(claimed.id, S.digest);
  const key = idempotencyKey(S.digest, claimed.nextRunAt);
  await q(`INSERT INTO schedule_executions (job_id, scheduled_for, idempotency_key, status, attempt, worker, lateness_ms) VALUES (:j, :sf, :k, 'running', 1, 'crashed', 0)`, { j: S.digest, sf: claimed.nextRunAt, k: key });
  const other = createWorker({ sequelize, cfg, fetchImpl: fakeFetch, workerId: 'other' });
  assert.deepEqual(await other.tick(), [], 'the lease still holds');
  await q(`UPDATE scheduled_jobs SET lease_until = now() - interval '1 second' WHERE id = :id`, { id: S.digest });
  hooks.length = 0;
  assert.deepEqual(await other.tick(), ['succeeded']);
  const ex = await q(`SELECT status, attempt FROM schedule_executions WHERE idempotency_key = :k`, { k: key });
  assert.deepEqual(ex, [{ status: 'succeeded', attempt: 2 }]); assert.equal(hooks[0].headers['X-EcoTime-Idempotency-Key'], key, 'receivers can de-duplicate');
  // an occurrence already completed is never run again, even if a stale claim appears
  await q(`UPDATE scheduled_jobs SET next_run_at = :sf WHERE id = :id`, { sf: claimed.nextRunAt, id: S.digest });
  hooks.length = 0; assert.deepEqual(await other.tick(), ['already_done']); assert.equal(hooks.length, 0);
  // failures: retry with backoff, then mark failed and move on
  await makeDue(S.digest); hookStatus = 500;
  assert.deepEqual(await other.tick(), ['retrying']);
  const [held] = await q(`SELECT lease_until > now() AS backoff, attempt FROM scheduled_jobs WHERE id = :id`, { id: S.digest }); assert.equal(held.backoff, true);
  await q(`UPDATE scheduled_jobs SET lease_until = now() - interval '1 second' WHERE id = :id`, { id: S.digest });
  assert.deepEqual(await other.tick(), ['failed']); hookStatus = 200;
  const [last] = await q(`SELECT status, attempt, result_code FROM schedule_executions WHERE job_id = :id ORDER BY started_at DESC LIMIT 1`, { id: S.digest });
  assert.deepEqual(last, { status: 'failed', attempt: 2, result_code: 'HTTP_500' });
  const [job] = await q(`SELECT status, next_run_at > now() AS future FROM scheduled_jobs WHERE id = :id`, { id: S.digest }); assert.deepEqual(job, { status: 'active', future: true });
  const exs = ok(await call('GET', `/api/v1/schedules/${S.digest}/executions`, { token: S.officeKey }));
  assert.ok(exs.length >= 3);
  const dup = await q(`SELECT count(*)::int AS n FROM (SELECT job_id, scheduled_for FROM schedule_executions GROUP BY 1, 2 HAVING count(*) > 1) x`); assert.equal(dup[0].n, 0);
});

test('email action and a one-time schedule that completes', { skip }, async () => {
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const s = ok(await call('POST', '/api/v1/schedules', { token: S.amina, body: { name: 'Call the bank', scheduleType: 'once', timeZone: 'Africa/Nairobi', startDate: tomorrow, localTime: '11:00', actionType: 'email', emailTo: 'amina@example.com', payload: { message: 'Ask about the statement' } } }), 201);
  await makeDue(s.id);
  const w = createWorker({ sequelize, cfg, mailer: { enabled: true, send: async (m) => { mails.push(m); return true; } }, workerId: 'mail' });
  assert.deepEqual(await w.tick(), ['succeeded']);
  assert.match(mails.at(-1).text, /Ask about the statement/); assert.match(mails.at(-1).text, /Africa\/Nairobi/);
  assert.equal(ok(await call('GET', `/api/v1/schedules/${s.id}`, { token: S.amina })).status, 'completed');
  ok(await call('DELETE', `/api/v1/schedules/${S.meeting}`, { token: S.amina }));
  assert.equal(ok(await call('GET', '/api/v1/schedules', { token: S.amina })).filter((x) => x.status === 'active').length, 0);
});

test('clock ingestion records state changes and steps; ruleset change recomputes schedules (§8.5, §9)', { skip }, async () => {
  const clock = createClockHealth({ sequelize, cfg });
  writeState({}); await new Promise((r) => setTimeout(r, 2100));
  assert.deepEqual((await clock.ingest()).events, ['state_change']);
  assert.deepEqual((await clock.ingest()).events, [], 'nothing new');
  writeState({ ntpSynchronized: false, stepDetectedAt: new Date().toISOString(), stepSizeS: 4.2 });
  const r = await clock.ingest(); assert.deepEqual(r.events.sort(), ['clock_step', 'state_change']);
  writeState({});
  const ev = ok(await call('GET', '/api/v1/sources/status', { token: S.admin }));
  assert.ok(ev.events.some((e) => e.kind === 'clock_step')); assert.equal(ev.sources[0].hostLabel, 'ntp.ubuntu.com');
  // ruleset: the first check records; a different runtime version later recomputes future instants from the intent
  const first = await checkRuleset(sequelize, cfg); assert.equal(first.runtime, process.versions.tz);
  await q(`UPDATE time_zone_rulesets SET runtime_version = '2000a', deployed_at = now() - interval '1 day'`);
  await q(`UPDATE scheduled_jobs SET next_run_at = next_run_at + interval '1 hour' WHERE id = :id`, { id: S.digest });
  const again = await checkRuleset(sequelize, cfg); assert.equal(again.recomputed, 1);
  fs.writeFileSync(TZFILE, '# version 2099z\n');
  const mismatch = await checkRuleset(sequelize, cfg); assert.equal(mismatch.os, '2099z');
  assert.equal((await q(`SELECT count(*)::int AS n FROM clock_health_events WHERE kind = 'ruleset_mismatch'`))[0].n, 1);
  assert.equal(ok(await call('GET', '/api/v1/time-zones/version', { token: S.amina })).agree, false);
  fs.writeFileSync(TZFILE, `# version ${process.versions.tz}\n`);
});

test('metrics only on loopback without proxy headers; audit is append-only; retention purge', { skip }, async () => {
  const m = await call('GET', '/metrics'); assert.equal(m.status, 200);
  assert.match(m.json, /clock_state\{host="ecocloud-prod-01",state="synchronized"\} 1/); assert.match(m.json, /schedule_duplicate_executions_total 0/);
  assert.equal((await call('GET', '/metrics', { headers: { 'x-forwarded-for': '1.2.3.4' } })).status, 404);
  await assert.rejects(q(`UPDATE audit_events SET action = 'x'`), /append-only/);
  await assert.rejects(q(`DELETE FROM audit_events`), /append-only/);
  const log = ok(await call('GET', '/api/v1/audit/events?limit=200', { token: S.admin }));
  assert.ok(log.some((l) => l.action === 'schedule.created') && log.some((l) => l.action === 'webhook.created'));
  assert.ok(!JSON.stringify(log).includes('whsec_'));
  await q(`UPDATE clock_observations SET observed_at = observed_at - interval '40 days'`);
  const p = await purge(sequelize); assert.ok(p.clock_observations >= 1);
  const t = ok(await call('POST', '/api/v1/support/tickets', { token: S.amina, body: { subject: 'Reminder', body: 'Did not get it' } }), 201);
  assert.match(t.ticketRef, /^ETM-/);
});
