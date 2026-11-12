// /api/v1 (§7.1). Strict schemas; unknown fields are rejected. Operators (local password + Authenticator) reach the
// operator routes; people and consuming apps reach the rest within their scopes and organizations.
import express from 'express';
import { z, parse } from '../../utils/validate.js';
import { authenticate, requireScope, requirePerson, requireAdmin } from '../../middleware/auth.js';
import { limiter } from '../../middleware/rateLimit.js';
import { notFound, badRequest } from '../../utils/errors.js';
import { isUuid } from '../../utils/ids.js';
import { SCOPES } from '../../auth/apiCredentials.js';
import { resolveLocal, applyPolicy, instantInZone, zoneInfo, zoneList, assertZone, runtimeTzVersion, fmtOffset } from '../../services/timezones/index.js';
import { IANAZone } from 'luxon';

const text = (max) => z.string().trim().min(1).max(max);
const optText = (max) => z.string().trim().max(max).optional().nullable().transform((v) => (v ? v : null));
const zone = z.string().min(1).max(80);
const lang = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const gap = z.enum(['shift_forward', 'skip']); const overlap = z.enum(['first', 'second']);
const intent = { name: text(160), scheduleType: z.enum(['once', 'recurring']), timeZone: zone, startDate: date, localTime: hhmm, recurrenceRule: z.string().max(500).optional().nullable(),
  dstGapPolicy: gap.optional(), dstOverlapPolicy: overlap.optional() };
const S = {
  exchange: z.strictObject({ ecoidToken: z.string().min(20).max(8192), language: lang.optional() }),
  refresh: z.strictObject({ refreshToken: z.string().min(20).max(200) }),
  adminLogin: z.strictObject({ email: z.string().email().max(320), password: z.string().min(1).max(256), code: z.string().regex(/^\d{6}$/) }),
  me: z.strictObject({ preferredLanguage: lang.optional(), preferredTimeZone: zone.optional().nullable(), displayName: text(160).optional() }),
  convert: z.union([z.strictObject({ instant: z.string().datetime({ offset: true }), timeZone: zone }),
    z.strictObject({ localDateTime: z.string().max(25), timeZone: zone, dstGapPolicy: gap.optional(), dstOverlapPolicy: overlap.optional() })]),
  preview: z.strictObject({ ...intent, name: text(160).optional(), count: z.number().int().min(1).max(50).optional(), actionType: z.enum(['record', 'webhook', 'email']).optional() }),
  schedule: z.strictObject({ ...intent, organizationId: z.string().uuid().optional(), actionType: z.enum(['record', 'webhook', 'email']), webhookEndpointId: z.string().uuid().optional().nullable(),
    emailTo: z.string().email().max(320).optional().nullable(), payload: z.record(z.string(), z.any()).optional() })
    .refine((b) => b.actionType !== 'webhook' || b.webhookEndpointId, 'webhookEndpointId is required for webhook actions')
    .refine((b) => b.actionType !== 'email' || b.emailTo, 'emailTo is required for email actions')
    .refine((b) => JSON.stringify(b.payload || {}).length <= 8192, 'payload is limited to 8 KB'),
  scheduleEdit: z.strictObject({ name: text(160).optional(), timeZone: zone.optional(), startDate: date.optional(), localTime: hhmm.optional(), recurrenceRule: z.string().max(500).optional(),
    dstGapPolicy: gap.optional(), dstOverlapPolicy: overlap.optional(), status: z.enum(['active', 'paused']).optional(), payload: z.record(z.string(), z.any()).optional(),
    emailTo: z.string().email().max(320).optional(), version: z.number().int().optional() }),
  support: z.strictObject({ subject: text(200), body: text(8000), email: z.string().email().max(320).optional().nullable() }),
  org: z.strictObject({ name: text(120), kind: z.enum(['app', 'team']).optional(), maxSchedules: z.number().int().min(1).max(100000).optional() }),
  orgEdit: z.strictObject({ name: text(120).optional(), status: z.enum(['active', 'suspended']).optional(), maxSchedules: z.number().int().min(1).max(100000).optional() }),
  member: z.strictObject({ userId: z.string().uuid(), role: z.enum(['owner', 'member']).optional() }),
  apiClient: z.strictObject({ organizationId: z.string().uuid(), name: text(120), appCode: z.string().regex(/^[A-Z0-9_]{2,40}$/), scopes: z.array(z.enum(SCOPES)).min(1), expiresInDays: z.number().int().min(1).max(3650).optional().nullable() }),
  webhook: z.strictObject({ organizationId: z.string().uuid(), name: text(120), url: z.string().url().max(500) }),
  source: z.strictObject({ hostLabel: text(160), operator: text(160), authenticated: z.boolean().optional(), tier: z.number().int().min(1).max(4).optional(), active: z.boolean().optional(), notes: optText(500) }),
  userEdit: z.strictObject({ status: z.enum(['active', 'disabled']) }),
};

export function v1Router(d) {
  const r = express.Router();
  const json = express.json({ limit: '32kb' });
  const auth = authenticate(d);
  const id = (req) => { if (!isUuid(req.params.id)) throw notFound('NOT_FOUND', 'Not found'); return req.params.id; };
  const h = (fn) => async (req, res, next) => { try { const out = await fn(req, res); if (!res.headersSent) res.json(out ?? { ok: true }); } catch (e) { next(e); } };
  const strict = limiter(60 * 1000, 60); // convert, preview and create (§7.4)

  r.get('/health', (req, res) => res.json({ status: 'ok' }));
  r.get('/languages', h(() => d.sequelize.query(`SELECT code, name, dir FROM languages ORDER BY name`).then(([x]) => x)));
  const authLimit = limiter(15 * 60 * 1000, 40);
  r.post('/auth/ecoid/exchange', authLimit, json, h(async (req) => d.authService.exchangeEcoId(parse(S.exchange, req.body), req)));
  r.post('/auth/refresh', limiter(60 * 1000, 30), json, h(async (req, res) => {
    const out = await d.sessions.rotate(parse(S.refresh, req.body).refreshToken);
    if (out.error === 'reused') await d.audit.log({ kind: out.subjectKind, id: out.subjectId }, 'auth.refresh_reuse', { req });
    if (out.error) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Please sign in again', requestId: req.id } });
    return out.pair;
  }));
  r.post('/auth/logout', json, h(async (req) => ({ revoked: await d.sessions.revoke(parse(S.refresh, req.body).refreshToken) })));
  r.post('/admin/auth/login', limiter(15 * 60 * 1000, 10), json, h(async (req) => d.authService.adminLogin(parse(S.adminLogin, req.body), req)));

  r.use(auth);
  r.get('/session', h(async (req) => ({ kind: req.actor.kind, ...(req.actor.kind === 'admin' ? { email: req.actor.email } : req.actor.kind === 'api' ? { client: req.actor.client.name, scopes: req.actor.scopes, organizationId: req.actor.client.organizationId }
    : { userId: req.actor.id, displayName: req.actor.user.displayName, preferredLanguage: req.actor.user.preferredLanguage }) })));
  r.get('/me', requirePerson, h(async (req) => {
    const [[u]] = await d.sequelize.query(`SELECT display_name AS "displayName", preferred_language AS "preferredLanguage", preferred_time_zone AS "preferredTimeZone" FROM users WHERE id = :id`, { replacements: { id: req.actor.id } });
    return { ...u, organizations: await d.orgs.mine(req.actor) };
  }));
  r.patch('/me', requirePerson, json, h(async (req) => {
    const b = parse(S.me, req.body); if (b.preferredTimeZone) assertZone(b.preferredTimeZone);
    await d.sequelize.query(`UPDATE users SET preferred_language = COALESCE(:l, preferred_language), preferred_time_zone = CASE WHEN :setz THEN :z ELSE preferred_time_zone END, display_name = COALESCE(:n, display_name) WHERE id = :id`,
      { replacements: { l: b.preferredLanguage || null, setz: 'preferredTimeZone' in b, z: b.preferredTimeZone || null, n: b.displayName || null, id: req.actor.id } });
    return { ok: true };
  }));

  // ---- time (§7.2, §7.3)
  r.get('/time/now', requireScope('time:read'), h(async (req) => ({ timestamp: new Date().toISOString(), timeZone: 'UTC', clockHealth: d.clock.current(), requestId: req.id })));
  r.get('/time/health', requireScope('time:read'), h(async (req) => ({ clockHealth: d.clock.current(), rulesets: d.clock.rulesets(), requestId: req.id })));
  r.post('/time/convert', requireScope('time:convert'), strict, json, h(async (req) => {
    const b = parse(S.convert, req.body);
    if ('instant' in b) return { ...instantInZone(Date.parse(b.instant), b.timeZone), rulesetVersion: runtimeTzVersion() };
    const res = resolveLocal(b.localDateTime, b.timeZone);
    const policy = res.resolution === 'nonexistent' ? (b.dstGapPolicy || 'shift_forward') : res.resolution === 'ambiguous' ? (b.dstOverlapPolicy || 'first') : null;
    const chosen = applyPolicy(res, { gap: b.dstGapPolicy, overlap: b.dstOverlapPolicy });
    return { localDateTime: b.localDateTime, timeZone: b.timeZone, resolution: res.resolution, policyApplied: policy,
      instants: chosen.map((x) => new Date(x).toISOString()), ...(res.resolution === 'ambiguous' ? { candidates: res.instants.map((x) => new Date(x).toISOString()) } : {}), rulesetVersion: runtimeTzVersion() };
  }));
  r.get('/time-zones', requireScope('time:read'), h(async () => {
    const now = Date.now();
    return { rulesetVersion: runtimeTzVersion(), zones: zoneList().map((z) => ({ id: z, currentOffset: fmtOffset(IANAZone.create(z).offset(now)) })) };
  }));
  r.get('/time-zones/version', requireScope('time:read'), h(async () => d.clock.rulesets()));
  r.get(/^\/time-zones\/([A-Za-z0-9_+\-]+(?:\/[A-Za-z0-9_+\-]+){0,2})$/, requireScope('time:read'), h(async (req) => zoneInfo(req.params[0])));
  r.get('/territories', requireScope('time:read'), h(() => d.sequelize.query(`SELECT code, name, time_zones AS "timeZones" FROM territories ORDER BY name`).then(([x]) => x)));

  // ---- schedules (§7.1)
  r.post('/schedules/preview', requireScope('schedules:read'), strict, json, h(async (req) => { const b = parse(S.preview, req.body); return d.scheduling.preview(b, b.count || 10); }));
  r.get('/schedules', requireScope('schedules:read'), h(async (req) => d.scheduling.list(req.actor, { organizationId: isUuid(req.query.organizationId) ? req.query.organizationId : undefined,
    status: ['active', 'paused', 'completed', 'failed'].includes(req.query.status) ? req.query.status : undefined })));
  r.post('/schedules', requireScope('schedules:write'), strict, json, h(async (req, res) => {
    const key = req.get('idempotency-key');
    if (key && !/^[A-Za-z0-9._:-]{8,100}$/.test(key)) throw badRequest('INVALID_INPUT', 'Idempotency-Key must be 8 to 100 letters, digits or . _ : -');
    const out = await d.scheduling.create(req.actor, parse(S.schedule, req.body), { idempotencyKey: key }, req);
    res.status(out.replayed ? 200 : 201); return out;
  }));
  r.get('/schedules/:id', requireScope('schedules:read'), h(async (req) => d.scheduling.get(req.actor, id(req))));
  r.patch('/schedules/:id', requireScope('schedules:write'), json, h(async (req) => d.scheduling.update(req.actor, id(req), parse(S.scheduleEdit, req.body), req)));
  r.delete('/schedules/:id', requireScope('schedules:write'), h(async (req) => d.scheduling.cancel(req.actor, id(req), req)));
  r.get('/schedules/:id/executions', requireScope('schedules:read'), h(async (req) => d.scheduling.executions(req.actor, id(req))));
  r.get('/organizations/mine', h(async (req) => d.orgs.mine(req.actor)));
  r.get('/webhooks', requireScope('schedules:read'), h(async (req) => d.webhooks.list(req.actor.kind === 'admin' ? null : req.actor.orgIds)));

  r.post('/support/tickets', requirePerson, json, h(async (req, res) => { const b = parse(S.support, req.body); res.status(201); return d.support.create({ globalEcoId: req.actor.user.globalEcoId, ...b }); }));
  r.get('/support/tickets', requirePerson, h(async (req) => d.support.inbox(req.actor.user.globalEcoId)));

  // ---- operators (§7.1: sources/status and audit/events are operator routes)
  r.get('/sources/status', requireAdmin, h(async () => ({ clockHealth: d.clock.current(), rulesets: d.clock.rulesets(), sources: await d.sources.list(), events: await d.clock.events(30) })));
  r.get('/audit/events', requireAdmin, h((req) => d.audit.list({ limit: req.query.limit, before: /^\d+$/.test(req.query.before || '') ? req.query.before : null })));
  const A = express.Router();
  A.use(requireAdmin);
  A.get('/clock/observations', h((req) => d.clock.observations(Math.min(Number(req.query.hours) || 24, 24 * 30))));
  A.get('/rulesets', h(() => d.sequelize.query(`SELECT runtime_version AS "runtimeVersion", os_version AS "osVersion", deployed_at AS "deployedAt", recomputed_schedules AS "recomputedSchedules" FROM time_zone_rulesets ORDER BY deployed_at DESC LIMIT 50`).then(([x]) => x)));
  A.post('/sources', json, h(async (req, res) => { res.status(201); return d.sources.upsert(req.actor, parse(S.source, req.body), d.audit, req); }));
  A.post('/sources/:id/deactivate', h(async (req) => d.sources.remove(req.actor, id(req), d.audit, req)));
  A.get('/organizations', h(() => d.orgs.list()));
  A.post('/organizations', json, h(async (req, res) => { res.status(201); return d.orgs.create(req.actor, parse(S.org, req.body), d.audit, req); }));
  A.patch('/organizations/:id', json, h(async (req) => d.orgs.update(req.actor, id(req), parse(S.orgEdit, req.body), d.audit, req)));
  A.post('/organizations/:id/members', json, h(async (req) => d.orgs.addMember(req.actor, id(req), parse(S.member, req.body), d.audit, req)));
  A.get('/users', h(() => d.orgs.users()));
  A.patch('/users/:id', json, h(async (req) => {
    const b = parse(S.userEdit, req.body);
    const [rows] = await d.sequelize.query(`UPDATE users SET status = :s WHERE id = :id RETURNING id`, { replacements: { s: b.status, id: id(req) } });
    if (!rows.length) throw notFound();
    if (b.status === 'disabled') await d.sessions.revokeAll('person', req.params.id);
    await d.audit.log(req.actor, 'user.updated', { subjectKind: 'user', subjectId: req.params.id, detail: b, req });
    return { ok: true };
  }));
  A.get('/api-clients', h(() => d.apiCredentials.list()));
  A.post('/api-clients', json, h(async (req, res) => { res.status(201); return d.apiCredentials.createClient(req.actor, parse(S.apiClient, req.body), d.audit, req); }));
  A.post('/api-clients/:id/rotate', h(async (req) => d.apiCredentials.rotate(req.actor, id(req), d.audit, req)));
  A.post('/api-clients/:id/revoke', h(async (req) => d.apiCredentials.revoke(req.actor, id(req), d.audit, req)));
  A.post('/webhooks', json, h(async (req, res) => { res.status(201); return d.webhooks.create(req.actor, parse(S.webhook, req.body), d.audit, req); }));
  A.post('/webhooks/:id/disable', h(async (req) => d.webhooks.setStatus(req.actor, id(req), 'disabled', d.audit, req)));
  A.get('/schedules', h(async (req) => d.scheduling.list(req.actor, {})));
  r.use('/admin', A);
  return r;
}
