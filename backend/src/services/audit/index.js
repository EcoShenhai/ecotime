// Audit trail (§8): administrative changes to providers, licences, data sources and places. Never coordinates, keys or codes.
import crypto from 'node:crypto';

export function createAudit({ sequelize, salt }) {
  const ipHash = (ip) => (ip ? crypto.createHmac('sha256', salt).update(String(ip)).digest('hex').slice(0, 16) : null);
  async function log(actor, action, { subjectKind = null, subjectId = null, detail = {}, req = null, transaction } = {}) {
    await sequelize.query(
      `INSERT INTO audit_events (actor_kind, actor_id, action, subject_kind, subject_id, detail, ip_hash) VALUES (:ak, :ai, :a, :sk, :si, :d, :ip)`,
      { replacements: { ak: actor?.kind || 'system', ai: actor?.id || null, a: action, sk: subjectKind, si: subjectId ? String(subjectId) : null, d: JSON.stringify(detail), ip: ipHash(req?.ip) }, transaction });
  }
  async function list({ limit = 100, before = null } = {}) {
    const [rows] = await sequelize.query(
      `SELECT l.id, l.at, l.actor_kind AS "actorKind", l.actor_id AS "actorId", COALESCE(p.display_name, a.email, c.name) AS "actorName",
              l.action, l.subject_kind AS "subjectKind", l.subject_id AS "subjectId", l.detail
         FROM audit_events l LEFT JOIN users p ON l.actor_kind = 'person' AND p.id = l.actor_id LEFT JOIN api_clients c ON l.actor_kind = 'api' AND c.id = l.actor_id
         LEFT JOIN admins a ON l.actor_kind = 'admin' AND a.id = l.actor_id
        WHERE (:before::bigint IS NULL OR l.id < :before::bigint) ORDER BY l.id DESC LIMIT :limit`,
      { replacements: { limit: Math.min(Number(limit) || 100, 500), before } });
    return rows;
  }
  return { log, list };
}
