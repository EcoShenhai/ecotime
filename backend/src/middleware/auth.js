// Callers (§7.5): people (EcoTime session after EcoID), operators (password + Authenticator), and consuming B2X
// apps with scoped API keys ("etk_…") tied to one organization. The subject is re-checked on every request, so disabling takes effect at once.
import { unauthorized, forbidden } from '../utils/errors.js';

export function authenticate({ sessions, sequelize, apiCredentials }, { required = true } = {}) {
  return async (req, res, next) => {
    try {
      const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
      if (!m) { if (required) throw unauthorized(); return next(); }
      const token = m[1].trim();
      if (token.startsWith('etk_')) {
        const c = await apiCredentials.verify(token);
        req.actor = { kind: 'api', id: c.id, client: c, scopes: c.scopes, orgIds: [c.organizationId] };
        return next();
      }
      let p;
      try { p = await sessions.verifyAccess(token); } catch { throw unauthorized('UNAUTHORIZED', 'Session expired or invalid'); }
      if (p.knd === 'admin') {
        const [[a]] = await sequelize.query(`SELECT id, email FROM admins WHERE id = :id AND disabled_at IS NULL`, { replacements: { id: p.sub } });
        if (!a) throw unauthorized('UNAUTHORIZED', 'Session expired or invalid');
        req.actor = { kind: 'admin', id: a.id, email: a.email, scopes: ['*'] };
      } else {
        const [[u]] = await sequelize.query(`SELECT id, global_eco_id AS "globalEcoId", display_name AS "displayName", preferred_language AS "preferredLanguage", status, preferred_time_zone AS "preferredTimeZone" FROM users WHERE id = :id`, { replacements: { id: p.sub } });
        if (!u || u.status !== 'active') throw unauthorized('UNAUTHORIZED', 'Session expired or invalid');
        const [orgs] = await sequelize.query(`SELECT organization_id AS id FROM organization_members WHERE user_id = :u ORDER BY created_at`, { replacements: { u: u.id } });
        req.actor = { kind: 'person', id: u.id, user: u, scopes: ['time:read', 'time:convert', 'schedules:read', 'schedules:write'], orgIds: orgs.map((o) => o.id) };
      }
      next();
    } catch (e) { next(e); }
  };
}
export const requireScope = (scope) => (req, res, next) => (req.actor && (req.actor.scopes.includes('*') || req.actor.scopes.includes(scope)) ? next() : next(forbidden('SCOPE_MISSING', `This credential lacks the ${scope} scope`)));
export const requirePerson = (req, res, next) => (req.actor?.kind === 'person' ? next() : next(forbidden('PERSON_ONLY', 'Sign in with EcoID for this')));
export const requireAdmin = (req, res, next) => (req.actor?.kind === 'admin' ? next() : next(forbidden('ADMIN_ONLY', 'Administrator sign-in required')));
