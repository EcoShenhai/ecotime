import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLocal, applyPolicy, instantInZone, zoneInfo, assertZone } from '../../src/services/timezones/index.js';
import { parseRule, nextOccurrence, preview } from '../../src/services/scheduling/recurrence.js';
import { parseTimesyncStatus, parseShow, durationUs, pollSeconds } from '../../src/services/clock-health/timesyncd.js';
import { evaluate } from '../../src/services/clock-health/evaluate.js';
import { checkWebhookUrl } from '../../src/services/scheduling/webhooks.js';
import { loadConfig } from '../../src/config/env.js';
import { redact } from '../../src/utils/logger.js';

const iso = (a) => a.map((x) => new Date(x).toISOString());
const NY = 'America/New_York';

test('conversion follows the reference examples (§7.3)', () => {
  const r = instantInZone(Date.parse('2026-10-22T12:30:00.000Z'), 'Africa/Nairobi');
  assert.equal(r.localDateTime, '2026-10-22T15:30:00'); assert.equal(r.utcOffset, '+03:00');
  const gap = resolveLocal('2027-03-14T02:30:00', NY);
  assert.equal(gap.resolution, 'nonexistent'); assert.deepEqual(iso(applyPolicy(gap, { gap: 'shift_forward' })), ['2027-03-14T07:30:00.000Z']);
  assert.deepEqual(applyPolicy(gap, { gap: 'skip' }), []);
  const amb = resolveLocal('2026-11-01T01:30', NY);
  assert.equal(amb.resolution, 'ambiguous'); assert.deepEqual(iso(amb.instants), ['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z']);
  assert.deepEqual(iso(applyPolicy(amb, { overlap: 'second' })), ['2026-11-01T06:30:00.000Z']);
  // half-hour DST shift (Lord Howe) and a half-hour zone (India) work the same way
  assert.equal(resolveLocal('2026-10-04T02:15', 'Australia/Lord_Howe').resolution, 'nonexistent');
  assert.deepEqual(iso(resolveLocal('2026-06-01T09:00', 'Asia/Kolkata').instants), ['2026-06-01T03:30:00.000Z']);
  assert.throws(() => assertZone('+03:00'), (e) => e.code === 'INVALID_TIME_ZONE');
  assert.throws(() => assertZone('Mars/Olympus'), (e) => e.code === 'INVALID_TIME_ZONE');
  assert.throws(() => resolveLocal('2026-02-30T10:00', 'Africa/Nairobi'), /does not exist/);
  const z = zoneInfo(NY, Date.parse('2026-11-12T00:00:00Z'));
  assert.equal(z.currentOffset, '-05:00'); assert.equal(z.nextTransitions[0].at, '2027-03-14T07:00:00.000Z');
  assert.equal(zoneInfo('Africa/Nairobi').observesDst, false);
});

test('recurring intent keeps local time across DST; policies apply per occurrence (§8.2, §8.3)', () => {
  const weekly = { scheduleType: 'recurring', timeZone: NY, startDateLocal: '2027-03-01', localTime: '09:00', recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO', dstGapPolicy: 'shift_forward', dstOverlapPolicy: 'first' };
  assert.deepEqual(preview(weekly, 4, Date.parse('2027-03-01T00:00:00Z')).map((o) => o.instant), ['2027-03-01T14:00:00.000Z', '2027-03-08T14:00:00.000Z', '2027-03-15T13:00:00.000Z', '2027-03-22T13:00:00.000Z']);
  assert.equal(new Date(nextOccurrence(weekly, Date.parse('2027-03-08T14:00:00Z'))).toISOString(), '2027-03-15T13:00:00.000Z');
  const daily = { ...weekly, localTime: '02:30', recurrenceRule: 'FREQ=DAILY', startDateLocal: '2027-03-12' };
  const shift = preview(daily, 4, Date.parse('2027-03-12T00:00:00Z'));
  assert.equal(shift[2].resolution, 'nonexistent'); assert.equal(shift[2].instant, '2027-03-14T07:30:00.000Z');
  const skip = preview({ ...daily, dstGapPolicy: 'skip' }, 4, Date.parse('2027-03-12T00:00:00Z'));
  assert.equal(skip[2].skipped, true);
  assert.equal(new Date(nextOccurrence({ ...daily, dstGapPolicy: 'skip' }, Date.parse('2027-03-13T07:30:00Z'))).toISOString(), '2027-03-15T06:30:00.000Z');
  // fall back: 01:30 happens twice; "first" runs once, at the earlier instant
  const fall = { ...weekly, localTime: '01:30', recurrenceRule: 'FREQ=DAILY', startDateLocal: '2026-10-31' };
  assert.deepEqual(preview(fall, 3, Date.parse('2026-10-31T00:00:00Z')).map((o) => o.instant), ['2026-10-31T05:30:00.000Z', '2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z']);
  // Nairobi never changes
  assert.equal(new Date(nextOccurrence({ ...weekly, timeZone: 'Africa/Nairobi', startDateLocal: '2026-11-16' }, Date.parse('2026-11-12T00:00:00Z'))).toISOString(), '2026-11-16T06:00:00.000Z');
  // once
  assert.equal(nextOccurrence({ scheduleType: 'once', timeZone: 'Africa/Nairobi', startDateLocal: '2020-01-01', localTime: '09:00' }, Date.now()), null);
});

test('recurrence rules are parsed and bounded before saving (§7.4)', () => {
  const o = { startDate: '2026-11-12', localTime: '09:00' };
  for (const [rule, why] of [['FREQ=SECONDLY', /FREQ/], ['FREQ=MINUTELY', /5 minutes/], ['FREQ=DAILY;BYHOUR=3', /BYHOUR/], ['FREQ=DAILY;UNTIL=20991231T000000Z', /UNTIL/], ['DTSTART:2026;FREQ=DAILY', /RRULE|supported/], ['<script>', /RRULE/]]) {
    assert.throws(() => parseRule(rule, o), (e) => e.code === 'INVALID_RECURRENCE' && why.test(e.message), rule);
  }
  assert.ok(parseRule('FREQ=MINUTELY;INTERVAL=15', o)); assert.ok(parseRule('RRULE:FREQ=MONTHLY;BYMONTHDAY=1,15', o));
});

test('timesyncd adapter parses the production output (§9.2)', () => {
  const s = parseTimesyncStatus(`       Server: 91.189.91.157 (ntp.ubuntu.com)
Poll interval: 34min 8s (min: 32s; max 34min 8s)
         Leap: normal
      Stratum: 2
Root distance: 23.338ms (max: 5s)
       Offset: -1.589ms
        Delay: 79.204ms
       Jitter: 4.119ms
 Packet count: 313
    Frequency: +37.899ppm`);
  assert.deepEqual([s.server, s.stratum, s.offsetUs, s.rootDistanceUs, s.jitterUs, s.pollIntervalS, s.packetCount], ['ntp.ubuntu.com', 2, -1589, 23338, 4119, 2048, 313]);
  assert.equal(durationUs('+345us'), 345); assert.equal(durationUs('1.2s'), 1200000); assert.equal(pollSeconds('1min 4s (min: 32s; max 34min 8s)'), 64);
  assert.deepEqual(parseShow('NTPSynchronized=yes\nNTP=yes\nTimezone=Etc/UTC'), { ntpSynchronized: true, ntpEnabled: true, timezone: 'Etc/UTC' });
});

test('clock state is never "synchronized" without a fresh observation that says so (T5, §7.2)', () => {
  const cfg = { maxAgeS: 120, offsetWarnMs: 50, rootDistanceWarnMs: 250, requireDiversity: false };
  const now = Date.parse('2026-11-12T14:00:00Z'); const fresh = { collectedAt: '2026-11-12T13:59:40Z', daemon: 'systemd-timesyncd', ntpSynchronized: true, offsetUs: -1589, rootDistanceUs: 23338, server: 'ntp.ubuntu.com' };
  assert.equal(evaluate(null, cfg, now).status, 'unknown');
  assert.equal(evaluate(fresh, cfg, now).status, 'synchronized');
  assert.equal(evaluate({ ...fresh, collectedAt: '2026-11-12T13:50:00Z' }, cfg, now).status, 'stale');
  assert.equal(evaluate({ ...fresh, ntpSynchronized: false }, cfg, now).status, 'unsynchronized');
  assert.equal(evaluate({ ...fresh, ntpSynchronized: undefined }, cfg, now).status, 'unknown');
  assert.equal(evaluate({ ...fresh, error: 'ENOENT' }, cfg, now).status, 'unknown');
  assert.equal(evaluate({ ...fresh, offsetUs: 80000 }, cfg, now).status, 'degraded');
  assert.equal(evaluate({ ...fresh, stepDetectedAt: '2026-11-12T13:30:00Z' }, cfg, now).status, 'degraded');
  assert.equal(evaluate(fresh, { ...cfg, requireDiversity: true }, now).status, 'degraded', 'one upstream is reduced diversity when policy asks for more');
  assert.equal(evaluate(fresh, cfg, now).diversity, 'single_source');
});

test('webhooks only to https Shenhai domains; config refuses unsafe settings', () => {
  const ok = ['eshcloud.com', 'theshenhai.com'];
  assert.equal(checkWebhookUrl('https://office.eshcloud.com/hooks/ecotime', ok), 'https://office.eshcloud.com/hooks/ecotime');
  for (const u of ['http://office.eshcloud.com/x', 'https://evil.com/x', 'https://eshcloud.com.evil.com/x', 'https://10.0.0.1/x', 'https://u:p@office.eshcloud.com/', 'https://[::1]/x']) assert.throws(() => checkWebhookUrl(u, ok), undefined, u);
  const base = { PORT: '1', DB_HOST: 'h', DB_PORT: '1', DB_NAME: 'ecotime_db', DB_USER: 'ecotime_user', DB_PASSWORD: 'x', ECOID_ISSUER: 'https://ecoid.eshcloud.com', PUBLIC_BASE_URL: 'https://time.eshcloud.com',
    SESSION_JWT_SECRET: 's'.repeat(40), REFRESH_TOKEN_PEPPER: 'p'.repeat(40), DATA_KEY: 'a'.repeat(64) };
  assert.throws(() => loadConfig({ ...base, NODE_TLS_REJECT_UNAUTHORIZED: '0' }), /forbidden/);
  const c = loadConfig({ ...base, DATABASE_URL: 'postgres://other/app' }); assert.equal(c.db.name, 'ecotime_db'); assert.equal(c.foreignDatabaseUrl, true);
  assert.equal(loadConfig({ ...base, ECOTIME_DATABASE_URL: 'postgres://ecotime_user:pw@db:25060/ecotime_db?sslmode=require' }).db.port, 25060);
  assert.ok(!/etk_|whsec_abc/.test(JSON.stringify(redact({ m: 'key etk_abcd1234_SECRETSECRETSECRETSECRETSECRETSE1 and whsec_abc' }))));
});
