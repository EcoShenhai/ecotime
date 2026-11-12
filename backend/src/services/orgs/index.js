// Organizations (tenants, §6.1). Each person has a personal organization; operators create app or team organizations,
// add members and issue API keys for them.
import { badRequest, notFound } from '../../utils/errors.js';
export function createOrgs({ sequelize }) {
  const q = (sql, replacements = {}) => sequelize.query(sql, { replacements }).then(([rows]) => rows);
  const list = () => q(`SELECT o.id, o.name, o.kind, o.status, o.max_schedules AS "maxSchedules", o.created_at AS "createdAt",
                               (SELECT count(*)::int FROM organization_members m WHERE m.organization_id = o.id) AS members,
                               (SELECT count(*)::int FROM scheduled_jobs j WHERE j.organization_id = o.id AND j.status IN ('active','paused')) AS schedules,
                               (SELECT count(*)::int FROM api_clients c WHERE c.organization_id = o.id AND c.status = 'active') AS "apiClients"
                          FROM organizations o ORDER BY o.kind = 'personal', o.name LIMIT 1000`);
  const mine = (actor) => (actor.orgIds?.length ? q(`SELECT o.id, o.name, o.kind, m.role FROM organizations o LEFT JOIN organization_members m ON m.organization_id = o.id AND m.user_id = :u
                                                      WHERE o.id IN (:ids) ORDER BY o.kind = 'personal' DESC, o.name`, { u: actor.kind === 'person' ? actor.id : null, ids: actor.orgIds }) : Promise.resolve([]));
  async function create(actor, { name, kind = 'app', maxSchedules = 500 }, audit, req) {
    const [o] = await q(`INSERT INTO organizations (name, kind, max_schedules) VALUES (:n, :k, :m) RETURNING id, name, kind`, { n: name, k: kind, m: maxSchedules });
    await audit.log(actor, 'organization.created', { subjectKind: 'organization', subjectId: o.id, detail: { kind }, req });
    return o;
  }
  async function update(actor, id, { status, maxSchedules, name }, audit, req) {
    const rows = await q(`UPDATE organizations SET status = COALESCE(:s, status), max_schedules = COALESCE(:m, max_schedules), name = COALESCE(:n, name) WHERE id = :id RETURNING id`, { s: status || null, m: maxSchedules || null, n: name || null, id });
    if (!rows.length) throw notFound('NOT_FOUND', 'Unknown organization');
    await audit.log(actor, 'organization.updated', { subjectKind: 'organization', subjectId: id, detail: { status, maxSchedules }, req });
    return { id };
  }
  async function addMember(actor, orgId, { userId, role = 'member' }, audit, req) {
    const [u] = await q(`SELECT id FROM users WHERE id = :u`, { u: userId }); if (!u) throw badRequest('INVALID_INPUT', 'Unknown user');
    await q(`INSERT INTO organization_members (organization_id, user_id, role) VALUES (:o, :u, :r) ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role`, { o: orgId, u: userId, r: role });
    await audit.log(actor, 'organization.member_added', { subjectKind: 'organization', subjectId: orgId, detail: { userId, role }, req });
    return { ok: true };
  }
  const users = () => q(`SELECT u.id, u.display_name AS "displayName", u.preferred_language AS "preferredLanguage", u.preferred_time_zone AS "preferredTimeZone", u.status, u.created_at AS "createdAt", u.last_seen_at AS "lastSeenAt",
                                (SELECT string_agg(o.name, ', ') FROM organization_members m JOIN organizations o ON o.id = m.organization_id WHERE m.user_id = u.id) AS organizations
                           FROM users u ORDER BY u.created_at DESC LIMIT 1000`);
  return { list, mine, create, update, addMember, users };
}
