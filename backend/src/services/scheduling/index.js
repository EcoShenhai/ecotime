// Durable schedules (T7, §7.1). Every schedule belongs to an organization; every route checks ownership (§6.1, §15.1
// scenario 6). Creating with an Idempotency-Key replays the first result (P9).
import crypto from 'node:crypto';
import { badRequest, notFound, conflict, limitExceeded } from '../../utils/errors.js';
import { assertZone, runtimeTzVersion } from '../timezones/index.js';
import { parseRule, nextOccurrence, preview as previewOcc } from './recurrence.js';

const COLS = `j.id, j.organization_id AS "organizationId", j.name, j.schedule_type AS "scheduleType", j.time_zone AS "timeZone", to_char(j.start_date_local, 'YYYY-MM-DD') AS "startDateLocal",
  j.local_time AS "localTime", j.recurrence_rule AS "recurrenceRule", j.dst_gap_policy AS "dstGapPolicy", j.dst_overlap_policy AS "dstOverlapPolicy", j.action_type AS "actionType",
  j.webhook_endpoint_id AS "webhookEndpointId", j.email_to AS "emailTo", j.payload, j.next_run_at AS "nextRunAt", j.status, j.attempt, j.last_run_at AS "lastRunAt", j.version,
  j.ruleset_version AS "rulesetVersion", j.created_at AS "createdAt", j.updated_at AS "updatedAt"`;

export function createScheduling({ sequelize, cfg, audit }) {
  const q = (sql, replacements = {}, transaction) => sequelize.query(sql, { replacements, transaction }).then(([rows]) => rows);
  const one = async (sql, r, t) => (await q(sql, r, t))[0] || null;

  function orgOf(actor, requested) {
    if (actor.kind === 'admin') { if (!requested) throw badRequest('INVALID_INPUT', 'organizationId is required'); return requested; }
    const ids = actor.orgIds || [];
    if (requested) { if (!ids.includes(requested)) throw notFound('NOT_FOUND', 'Unknown organization'); return requested; }
    if (!ids.length) throw badRequest('INVALID_INPUT', 'No organization for this caller');
    return ids[0];
  }
  function intentFrom(b) {
    assertZone(b.timeZone);
    const job = { scheduleType: b.scheduleType, timeZone: b.timeZone, startDateLocal: b.startDate, localTime: b.localTime, recurrenceRule: b.recurrenceRule || null,
      dstGapPolicy: b.dstGapPolicy || 'shift_forward', dstOverlapPolicy: b.dstOverlapPolicy || 'first' };
    if (job.scheduleType === 'recurring') {
      if (!job.recurrenceRule) throw badRequest('INVALID_RECURRENCE', 'A recurring schedule needs recurrenceRule');
      parseRule(job.recurrenceRule, { startDate: job.startDateLocal, localTime: job.localTime, minIntervalMin: b.actionType === 'email' ? cfg.limits.emailMinIntervalMin : cfg.limits.minIntervalMin, horizonDays: cfg.limits.horizonDays });
    } else job.recurrenceRule = null;
    return job;
  }

  function preview(b, count = 10) {
    const job = intentFrom(b);
    return { timeZone: job.timeZone, dstGapPolicy: job.dstGapPolicy, dstOverlapPolicy: job.dstOverlapPolicy, rulesetVersion: runtimeTzVersion(), occurrences: previewOcc(job, Math.min(count, cfg.limits.previewMax)) };
  }

  async function create(actor, b, { idempotencyKey } = {}, req) {
    const orgId = orgOf(actor, b.organizationId);
    const hash = crypto.createHash('sha256').update(JSON.stringify(b)).digest('hex');
    const scope = `schedules:${actor.kind}:${actor.id}`;
    if (idempotencyKey) {
      const seen = await one(`SELECT request_hash AS h, result_ref AS id FROM idempotency_keys WHERE scope = :s AND key = :k`, { s: scope, k: idempotencyKey });
      if (seen) { if (seen.h !== hash) throw conflict('IDEMPOTENCY_MISMATCH', 'This Idempotency-Key was used with a different request'); return { ...(await get(actor, seen.id)), replayed: true }; }
    }
    const job = intentFrom(b);
    const next = nextOccurrence(job, Date.now());
    if (next == null) throw badRequest('INVALID_INPUT', job.scheduleType === 'once' ? 'That time is in the past (or skipped by the DST policy)' : 'The rule has no future occurrences');
    return sequelize.transaction(async (t) => {
      const org = await one(`SELECT max_schedules AS max, (SELECT count(*)::int FROM scheduled_jobs WHERE organization_id = :o AND status IN ('active','paused')) AS n FROM organizations WHERE id = :o AND status = 'active' FOR UPDATE`, { o: orgId }, t);
      if (!org) throw notFound('NOT_FOUND', 'Unknown organization');
      if (org.n >= org.max) throw limitExceeded(`This organization already has ${org.n} schedules (limit ${org.max})`);
      if (b.actionType === 'webhook' && !(await one(`SELECT 1 AS x FROM webhook_endpoints WHERE id = :w AND organization_id = :o AND status = 'active'`, { w: b.webhookEndpointId, o: orgId }, t))) throw badRequest('INVALID_INPUT', 'Unknown webhook endpoint for this organization');
      const r = await one(`INSERT INTO scheduled_jobs (organization_id, name, schedule_type, time_zone, start_date_local, local_time, recurrence_rule, dst_gap_policy, dst_overlap_policy,
                             action_type, webhook_endpoint_id, email_to, payload, next_run_at, ruleset_version, created_by)
                           VALUES (:o, :name, :st, :tz, :sd, :lt, :rr, :gp, :op, :at, :wh, :em, :pl, :next, :rv, :by) RETURNING id`,
      { o: orgId, name: b.name, st: job.scheduleType, tz: job.timeZone, sd: job.startDateLocal, lt: job.localTime, rr: job.recurrenceRule, gp: job.dstGapPolicy, op: job.dstOverlapPolicy,
        at: b.actionType, wh: b.webhookEndpointId || null, em: b.emailTo || null, pl: JSON.stringify(b.payload || {}), next: new Date(next), rv: runtimeTzVersion(), by: `${actor.kind}:${actor.id}` }, t);
      if (idempotencyKey) await q(`INSERT INTO idempotency_keys (key, scope, request_hash, result_ref) VALUES (:k, :s, :h, :r)`, { k: idempotencyKey, s: scope, h: hash, r: r.id }, t);
      await audit.log(actor, 'schedule.created', { subjectKind: 'schedule', subjectId: r.id, detail: { organizationId: orgId, scheduleType: job.scheduleType, actionType: b.actionType }, req, transaction: t });
      return r;
    }).then((r) => get(actor, r.id));
  }

  async function load(actor, id, t, lock = false) {
    const j = await one(`SELECT ${COLS} FROM scheduled_jobs j WHERE j.id = :id ${lock ? 'FOR UPDATE' : ''}`, { id }, t);
    // another organization's schedule is indistinguishable from a missing one
    if (!j || (actor.kind !== 'admin' && !(actor.orgIds || []).includes(j.organizationId))) throw notFound('NOT_FOUND', 'Schedule not found');
    return j;
  }
  async function get(actor, id) {
    const j = await load(actor, id);
    return { ...j, upcoming: j.status === 'active' ? previewOcc(j, 5) : [] };
  }
  async function list(actor, { organizationId, status } = {}) {
    const ids = actor.kind === 'admin' ? null : organizationId ? [orgOf(actor, organizationId)] : actor.orgIds;
    if (ids && !ids.length) return [];
    return q(`SELECT ${COLS}, o.name AS "organizationName",
                     (SELECT round(avg(e.lateness_ms))::int FROM schedule_executions e WHERE e.job_id = j.id AND e.started_at > now() - interval '7 days') AS "avgLatenessMs",
                     (SELECT e.status FROM schedule_executions e WHERE e.job_id = j.id ORDER BY e.started_at DESC LIMIT 1) AS "lastResult"
                FROM scheduled_jobs j JOIN organizations o ON o.id = j.organization_id
               WHERE (:all OR j.organization_id IN (:ids)) AND (:st::text IS NULL OR j.status = :st) AND j.status <> 'disabled'
               ORDER BY j.status = 'active' DESC, j.next_run_at NULLS LAST LIMIT 500`, { all: !ids, ids: ids || ['00000000-0000-0000-0000-000000000000'], st: status || null });
  }

  async function update(actor, id, patch, req) {
    return sequelize.transaction(async (t) => {
      const j = await load(actor, id, t, true);
      if (patch.version !== undefined && patch.version !== j.version) throw conflict('VERSION_CONFLICT', 'The schedule has changed; reload and try again');
      if (['completed', 'failed', 'disabled'].includes(j.status)) throw conflict('NOT_EDITABLE', `A ${j.status} schedule cannot be changed`);
      const merged = { ...j, ...Object.fromEntries(Object.entries({ name: patch.name, timeZone: patch.timeZone, startDate: patch.startDate, localTime: patch.localTime, recurrenceRule: patch.recurrenceRule,
        dstGapPolicy: patch.dstGapPolicy, dstOverlapPolicy: patch.dstOverlapPolicy, payload: patch.payload, emailTo: patch.emailTo }).filter(([, v]) => v !== undefined)) };
      const job = intentFrom({ ...merged, startDate: patch.startDate || j.startDateLocal, actionType: j.actionType });
      let status = j.status;
      if (patch.status === 'paused' && j.status === 'active') status = 'paused';
      if (patch.status === 'active' && j.status === 'paused') status = 'active';
      // the next instant is always recalculated from the intent (T3)
      const next = nextOccurrence(job, Date.now());
      if (status === 'active' && next == null) throw badRequest('INVALID_INPUT', 'The schedule has no future occurrences');
      await q(`UPDATE scheduled_jobs SET name = :name, time_zone = :tz, start_date_local = :sd, local_time = :lt, recurrence_rule = :rr, dst_gap_policy = :gp, dst_overlap_policy = :op,
                 payload = :pl, email_to = :em, status = :status, next_run_at = :next, attempt = 0, lease_until = NULL, claimed_by = NULL, version = version + 1, updated_at = now(), ruleset_version = :rv
               WHERE id = :id`,
      { id, name: merged.name, tz: job.timeZone, sd: job.startDateLocal, lt: job.localTime, rr: job.recurrenceRule, gp: job.dstGapPolicy, op: job.dstOverlapPolicy, pl: JSON.stringify(merged.payload || {}),
        em: merged.emailTo || null, status, next: next ? new Date(next) : null, rv: runtimeTzVersion() }, t);
      await audit.log(actor, status !== j.status ? `schedule.${status === 'paused' ? 'paused' : 'resumed'}` : 'schedule.updated', { subjectKind: 'schedule', subjectId: id, detail: { fields: Object.keys(patch) }, req, transaction: t });
      return { id };
    }).then(() => get(actor, id));
  }
  async function cancel(actor, id, req) {
    const j = await load(actor, id);
    await q(`UPDATE scheduled_jobs SET status = 'disabled', next_run_at = NULL, lease_until = NULL, version = version + 1, updated_at = now() WHERE id = :id`, { id });
    await audit.log(actor, 'schedule.cancelled', { subjectKind: 'schedule', subjectId: id, detail: { previous: j.status }, req });
    return { id, status: 'disabled' };
  }
  async function executions(actor, id) {
    await load(actor, id);
    return q(`SELECT id, scheduled_for AS "scheduledFor", status, attempt, worker, started_at AS "startedAt", finished_at AS "finishedAt", lateness_ms AS "latenessMs", result_code AS "resultCode", detail
                FROM schedule_executions WHERE job_id = :id ORDER BY scheduled_for DESC, attempt DESC LIMIT 200`, { id });
  }
  return { preview, create, get, list, update, cancel, executions, orgOf };
}
