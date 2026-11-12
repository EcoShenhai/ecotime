// Webhook endpoints (§8.4 actions). Registered by operators per organization; HTTPS only, to an allow-listed Shenhai
// domain, never an IP address or a URL with credentials (SSRF). The signing secret is shown once and stored sealed.
import crypto from 'node:crypto';
import net from 'node:net';
import { seal } from '../../auth/crypto.js';
import { badRequest, notFound } from '../../utils/errors.js';

export function checkWebhookUrl(url, allowedDomains) {
  let u; try { u = new URL(url); } catch { throw badRequest('INVALID_INPUT', 'Not a valid URL'); }
  if (u.protocol !== 'https:') throw badRequest('INVALID_INPUT', 'Webhooks must use https');
  if (u.username || u.password) throw badRequest('INVALID_INPUT', 'Webhook URLs may not contain credentials');
  const host = u.hostname.toLowerCase();
  if (net.isIP(host.replace(/^\[|\]$/g, ''))) throw badRequest('INVALID_INPUT', 'Webhook URLs must use a domain name, not an IP address');
  if (!allowedDomains.some((d) => host === d || host.endsWith(`.${d}`))) throw badRequest('INVALID_INPUT', `Webhook domain must be one of: ${allowedDomains.join(', ')}`);
  return u.toString();
}

export function createWebhooks({ sequelize, cfg }) {
  const q = (sql, replacements = {}) => sequelize.query(sql, { replacements }).then(([rows]) => rows);
  async function create(actor, { organizationId, name, url }, audit, req) {
    const clean = checkWebhookUrl(url, cfg.webhooks.allowedDomains);
    const [o] = await q(`SELECT id FROM organizations WHERE id = :o`, { o: organizationId });
    if (!o) throw badRequest('INVALID_INPUT', 'Unknown organization');
    const id = crypto.randomUUID(); const secret = `whsec_${crypto.randomBytes(24).toString('base64url')}`;
    await q(`INSERT INTO webhook_endpoints (id, organization_id, name, url, secret_enc, created_by) VALUES (:id, :o, :n, :u, :s, :by)`,
      { id, o: organizationId, n: name, u: clean, s: seal(cfg.dataKey, secret, `webhook:${id}`), by: `${actor.kind}:${actor.id}` });
    await audit.log(actor, 'webhook.created', { subjectKind: 'webhook', subjectId: id, detail: { organizationId, host: new URL(clean).hostname }, req });
    return { id, url: clean, secret };
  }
  const list = (orgIds) => q(`SELECT w.id, w.organization_id AS "organizationId", o.name AS "organizationName", w.name, w.url, w.status, w.created_at AS "createdAt"
                                FROM webhook_endpoints w JOIN organizations o ON o.id = w.organization_id WHERE (:all OR w.organization_id IN (:ids)) ORDER BY w.created_at DESC`,
  { all: !orgIds, ids: orgIds?.length ? orgIds : ['00000000-0000-0000-0000-000000000000'] });
  async function setStatus(actor, id, status, audit, req) {
    const rows = await q(`UPDATE webhook_endpoints SET status = :s WHERE id = :id RETURNING id`, { s: status, id });
    if (!rows.length) throw notFound('NOT_FOUND', 'Unknown webhook');
    await audit.log(actor, `webhook.${status}`, { subjectKind: 'webhook', subjectId: id, req });
    return { id, status };
  }
  return { create, list, setStatus };
}
