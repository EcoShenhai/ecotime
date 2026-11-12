// Consuming apps (§7.5): scoped, revocable keys "etk_<prefix>_<secret>", each tied to one organization. Only an HMAC
// of the secret is stored; the full key is shown once. Revocation takes effect at once.
import crypto from 'node:crypto';
import { unauthorized, notFound, badRequest } from '../utils/errors.js';

export const SCOPES = ['time:read', 'time:convert', 'schedules:read', 'schedules:write'];

export function createApiCredentials({ sequelize, cfg }) {
  const q = (sql, replacements = {}, transaction) => sequelize.query(sql, { replacements, transaction }).then(([rows]) => rows);
  const hash = (secret) => crypto.createHmac('sha256', cfg.refreshPepper).update(`apikey:${secret}`).digest('hex');

  async function verify(key) {
    const m = /^etk_([a-z0-9]{8})_([A-Za-z0-9_-]{32,64})$/.exec(key);
    if (!m) throw unauthorized('UNAUTHORIZED', 'Invalid API key');
    const [c] = await q(`SELECT k.id AS "keyId", k.key_hash AS "hash", c.id, c.name, c.app_code AS "appCode", c.scopes, c.organization_id AS "organizationId"
                           FROM api_credentials k JOIN api_clients c ON c.id = k.client_id JOIN organizations o ON o.id = c.organization_id
                          WHERE k.key_prefix = :p AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now()) AND c.status = 'active' AND o.status = 'active'`, { p: m[1] });
    const expected = c ? Buffer.from(c.hash, 'hex') : Buffer.alloc(32);
    const got = Buffer.from(hash(m[2]), 'hex');
    if (!c || !crypto.timingSafeEqual(expected, got)) throw unauthorized('UNAUTHORIZED', 'Invalid API key');
    q(`UPDATE api_credentials SET last_used_at = now() WHERE id = :id AND (last_used_at IS NULL OR last_used_at < now() - interval '5 minutes')`, { id: c.keyId }).catch(() => {});
    return c;
  }
  async function issueKey(clientId, expiresInDays, t) {
    const prefix = crypto.randomBytes(6).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').padEnd(8, '0').slice(0, 8);
    const secret = crypto.randomBytes(32).toString('base64url');
    const [k] = await q(`INSERT INTO api_credentials (client_id, key_prefix, key_hash, expires_at) VALUES (:c, :p, :h, CASE WHEN :d::int IS NULL THEN NULL ELSE now() + make_interval(days => :d::int) END) RETURNING expires_at AS "expiresAt"`,
      { c: clientId, p: prefix, h: hash(secret), d: expiresInDays }, t);
    return { key: `etk_${prefix}_${secret}`, prefix, expiresAt: k.expiresAt };
  }
  async function createClient(actor, { organizationId, name, appCode, scopes, expiresInDays = null }, audit, req) {
    if (scopes.some((s) => !SCOPES.includes(s))) throw badRequest('INVALID_INPUT', 'Unknown scope');
    return sequelize.transaction(async (t) => {
      const [o] = await q(`SELECT id FROM organizations WHERE id = :o AND status = 'active'`, { o: organizationId }, t);
      if (!o) throw badRequest('INVALID_INPUT', 'Unknown organization');
      const [c] = await q(`INSERT INTO api_clients (organization_id, name, app_code, scopes, created_by) VALUES (:o, :n, :a, ARRAY[:s]::text[], :by) RETURNING id`,
        { o: organizationId, n: name, a: appCode, s: scopes, by: `${actor.kind}:${actor.id}` }, t);
      const key = await issueKey(c.id, expiresInDays, t);
      await audit.log(actor, 'api_client.created', { subjectKind: 'api_client', subjectId: c.id, detail: { appCode, scopes, organizationId }, req, transaction: t });
      return { id: c.id, apiKey: key.key, keyPrefix: key.prefix, expiresAt: key.expiresAt };
    });
  }
  async function rotate(actor, clientId, audit, req) {
    return sequelize.transaction(async (t) => {
      const [c] = await q(`SELECT id FROM api_clients WHERE id = :id AND status = 'active'`, { id: clientId }, t);
      if (!c) throw notFound('NOT_FOUND', 'Unknown or revoked client');
      await q(`UPDATE api_credentials SET revoked_at = now() WHERE client_id = :id AND revoked_at IS NULL`, { id: clientId }, t);
      const key = await issueKey(clientId, null, t);
      await audit.log(actor, 'api_client.key_rotated', { subjectKind: 'api_client', subjectId: clientId, req, transaction: t });
      return { apiKey: key.key, keyPrefix: key.prefix };
    });
  }
  async function revoke(actor, clientId, audit, req) {
    const rows = await q(`UPDATE api_clients SET status = 'revoked', revoked_at = now() WHERE id = :id AND status = 'active' RETURNING id`, { id: clientId });
    if (!rows.length) throw notFound('NOT_FOUND', 'Unknown or already revoked client');
    await q(`UPDATE api_credentials SET revoked_at = now() WHERE client_id = :id AND revoked_at IS NULL`, { id: clientId });
    await audit.log(actor, 'api_client.revoked', { subjectKind: 'api_client', subjectId: clientId, req });
    return { id: clientId, status: 'revoked' };
  }
  const list = () => q(`SELECT c.id, c.name, c.app_code AS "appCode", c.scopes, c.status, c.created_at AS "createdAt", c.organization_id AS "organizationId", o.name AS "organizationName",
                               (SELECT k.key_prefix FROM api_credentials k WHERE k.client_id = c.id AND k.revoked_at IS NULL ORDER BY k.created_at DESC LIMIT 1) AS "keyPrefix",
                               (SELECT max(k.last_used_at) FROM api_credentials k WHERE k.client_id = c.id) AS "lastUsedAt"
                          FROM api_clients c JOIN organizations o ON o.id = c.organization_id ORDER BY c.created_at DESC`);
  return { verify, createClient, rotate, revoke, list };
}
