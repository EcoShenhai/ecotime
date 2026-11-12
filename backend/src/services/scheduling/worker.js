// Scheduler worker (§8.4). Claims due schedules under a lease decided by the database clock, records one execution row
// per occurrence (deterministic idempotency key: job id + scheduled instant), runs the action with a bounded timeout
// (monotonic timers, T4), then advances to the next occurrence calculated from the intent. Retries back off; after the
// last attempt the occurrence is marked failed and the schedule moves on. Lateness is recorded, never hidden.
import crypto from 'node:crypto';
import os from 'node:os';
import { open as unseal } from '../../auth/crypto.js';
import { nextOccurrence } from './recurrence.js';
import { checkWebhookUrl } from './webhooks.js';
import { instantInZone } from '../timezones/index.js';
import { logger } from '../../utils/logger.js';

export const idempotencyKey = (jobId, scheduledFor) => crypto.createHash('sha256').update(`${jobId}|${new Date(scheduledFor).toISOString()}`).digest('hex');

export function createWorker({ sequelize, cfg, mailer, fetchImpl = fetch, workerId }) {
  const id = workerId || cfg.scheduler.workerId || `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`;
  const q = (sql, replacements = {}, transaction) => sequelize.query(sql, { replacements, transaction }).then(([rows]) => rows);
  const stats = { claimed: 0, succeeded: 0, failed: 0, retried: 0, duplicatesPrevented: 0 };

  // Claim up to `batch` due jobs in one statement; SKIP LOCKED lets several workers run side by side.
  async function claim(batch = cfg.scheduler.batch) {
    return q(`UPDATE scheduled_jobs j SET lease_until = now() + make_interval(secs => :lease), claimed_by = :w
               WHERE j.id IN (SELECT id FROM scheduled_jobs WHERE status = 'active' AND next_run_at <= now() AND (lease_until IS NULL OR lease_until < now())
                               ORDER BY next_run_at FOR UPDATE SKIP LOCKED LIMIT :n)
           RETURNING j.id, j.organization_id AS "organizationId", j.name, j.schedule_type AS "scheduleType", j.time_zone AS "timeZone", to_char(j.start_date_local, 'YYYY-MM-DD') AS "startDateLocal",
                     j.local_time AS "localTime", j.recurrence_rule AS "recurrenceRule", j.dst_gap_policy AS "dstGapPolicy", j.dst_overlap_policy AS "dstOverlapPolicy", j.action_type AS "actionType",
                     j.webhook_endpoint_id AS "webhookEndpointId", j.email_to AS "emailTo", j.payload, j.next_run_at AS "nextRunAt", j.attempt`,
    { lease: cfg.scheduler.leaseMs / 1000, w: id, n: batch });
  }

  async function act(job, scheduledFor, key, attempt) {
    const clock = { scheduledFor: new Date(scheduledFor).toISOString(), local: instantInZone(new Date(scheduledFor).getTime(), job.timeZone) };
    if (job.actionType === 'record') return { code: 'RECORDED', detail: {} };
    if (job.actionType === 'email') {
      if (!mailer?.enabled) { const e = new Error('mail not configured'); e.code = 'MAIL_DISABLED'; throw e; }
      await mailer.send({ to: job.emailTo, subject: `[EcoTime] ${job.name}`,
        text: `${job.name}\n\nScheduled for ${clock.local.localDateTime} (${job.timeZone}, UTC${clock.local.utcOffset})\n= ${clock.scheduledFor} UTC\n\n${job.payload?.message ? String(job.payload.message).slice(0, 2000) + '\n\n' : ''}Shenhai EcoTime` });
      return { code: 'EMAIL_SENT', detail: {} };
    }
    const [ep] = await q(`SELECT id, url, secret_enc AS "secretEnc", status FROM webhook_endpoints WHERE id = :id AND organization_id = :o`, { id: job.webhookEndpointId, o: job.organizationId });
    if (!ep || ep.status !== 'active') { const e = new Error('endpoint unavailable'); e.code = 'ENDPOINT_DISABLED'; throw e; }
    checkWebhookUrl(ep.url, cfg.webhooks.allowedDomains);
    const body = JSON.stringify({ event: 'SCHEDULE_DUE', scheduleId: job.id, organizationId: job.organizationId, name: job.name, scheduledFor: clock.scheduledFor,
      localTime: clock.local.localDateTime, timeZone: job.timeZone, firedAt: new Date().toISOString(), attempt, idempotencyKey: key, payload: job.payload || {} });
    const ts = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', unseal(cfg.dataKey, ep.secretEnc, `webhook:${ep.id}`)).update(`${ts}.${body}`).digest('hex');
    const r = await fetchImpl(ep.url, { method: 'POST', body, redirect: 'manual', signal: AbortSignal.timeout(cfg.scheduler.actionTimeoutMs),
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Shenhai-EcoTime/1.0', 'X-EcoTime-Signature': `t=${ts},v1=${sig}`, 'X-EcoTime-Idempotency-Key': key, 'X-EcoTime-Scheduled-For': clock.scheduledFor } });
    if (r.status < 200 || r.status >= 300) { const e = new Error(`HTTP ${r.status}`); e.code = `HTTP_${r.status}`; throw e; }
    return { code: `HTTP_${r.status}`, detail: {} };
  }

  async function advance(job, scheduledFor, { failedOccurrence = false } = {}) {
    const after = Math.max(new Date(scheduledFor).getTime(), Date.now());
    let next = null;
    // a one-time schedule has exactly one occurrence: once it has run (or finally failed) it never runs again
    if (job.scheduleType !== 'once') try { next = nextOccurrence(job, after); } catch (e) { logger.warn('next occurrence failed', { job: job.id, err: e.code || e.message }); }
    const status = next != null ? 'active' : job.scheduleType === 'once' && failedOccurrence ? 'failed' : 'completed';
    await q(`UPDATE scheduled_jobs SET next_run_at = :next, status = CASE WHEN status = 'active' THEN :st ELSE status END, lease_until = NULL, claimed_by = NULL, attempt = 0,
               last_run_at = now(), updated_at = now() WHERE id = :id AND claimed_by = :w`, { next: next ? new Date(next) : null, st: status, id: job.id, w: id });
  }

  async function runJob(job) {
    const scheduledFor = job.nextRunAt; const key = idempotencyKey(job.id, scheduledFor);
    // one execution row per occurrence; a retry or a reclaimed lease bumps the attempt on the same row
    const [ex] = await q(`INSERT INTO schedule_executions (job_id, scheduled_for, idempotency_key, status, attempt, worker, lateness_ms)
                          VALUES (:j, :sf, :k, 'running', 1, :w, GREATEST(0, (EXTRACT(EPOCH FROM (clock_timestamp() - :sf::timestamptz)) * 1000)::bigint))
                          ON CONFLICT (idempotency_key) DO UPDATE SET attempt = schedule_executions.attempt + 1, status = 'running', worker = EXCLUDED.worker, started_at = now()
                            WHERE schedule_executions.status IN ('running','retrying')
                          RETURNING id, attempt`, { j: job.id, sf: scheduledFor, k: key, w: id });
    if (!ex) { stats.duplicatesPrevented++; await advance(job, scheduledFor); return 'already_done'; }
    const t0 = performance.now();
    try {
      const r = await act(job, scheduledFor, key, ex.attempt);
      await q(`UPDATE schedule_executions SET status = 'succeeded', finished_at = now(), result_code = :c, detail = :d WHERE id = :id`, { id: ex.id, c: r.code, d: JSON.stringify({ ...r.detail, durationMs: Math.round(performance.now() - t0) }) });
      stats.succeeded++; await advance(job, scheduledFor); return 'succeeded';
    } catch (e) {
      const code = String(e.code || (e.name === 'TimeoutError' ? 'TIMEOUT' : 'ERROR')).slice(0, 64);
      if (ex.attempt < cfg.scheduler.maxAttempts) {
        const backoff = Math.min(30 * 2 ** (ex.attempt - 1), 1800);
        await q(`UPDATE schedule_executions SET status = 'retrying', result_code = :c, detail = :d WHERE id = :id`, { id: ex.id, c: code, d: JSON.stringify({ retryInSeconds: backoff }) });
        await q(`UPDATE scheduled_jobs SET lease_until = now() + make_interval(secs => :b), claimed_by = NULL, attempt = :a, updated_at = now() WHERE id = :id AND claimed_by = :w`, { b: backoff, a: ex.attempt, id: job.id, w: id });
        stats.retried++; return 'retrying';
      }
      await q(`UPDATE schedule_executions SET status = 'failed', finished_at = now(), result_code = :c WHERE id = :id`, { id: ex.id, c: code });
      stats.failed++; logger.warn('schedule execution failed', { job: job.id, code, attempts: ex.attempt });
      await advance(job, scheduledFor, { failedOccurrence: true }); return 'failed';
    }
  }

  async function tick() {
    const jobs = await claim();
    stats.claimed += jobs.length;
    const out = [];
    for (const j of jobs) { try { out.push(await runJob(j)); } catch (e) { logger.error('job crashed', { job: j.id, err: e }); out.push('error'); } }
    return out;
  }
  return { id, tick, claim, runJob, stats };
}
