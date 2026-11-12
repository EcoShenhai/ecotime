// Sign-in (§7.5, §12.2). People: EcoID token → EcoTime session. The EcoID subject is stored as global_eco_id and never
// replaces the EcoTime user id; there is no linking by email (E7). Tokens claiming administrator rights are refused.
// Administrators (E12): email + password + a code from Shenhai Authenticator, lockout, one-time use of each code step.
import { unauthorized, forbidden, locked } from '../utils/errors.js';
import { verifyPassword, DUMMY_HASH, open, verifyTotp } from '../auth/crypto.js';

export function createAuthService({ sequelize, cfg, ecoid, sessions, audit }) {
  async function exchangeEcoId({ ecoidToken, language }, req) {
    let p;
    try { p = await ecoid.verify(ecoidToken); } catch { throw unauthorized('ECOID_INVALID', 'EcoID sign-in could not be verified'); }
    if (ecoid.claimsAdmin(p)) throw forbidden('ADMIN_NOT_ALLOWED', 'Administrator accounts cannot use EcoID sign-in here');
    const name = typeof p.name === 'string' ? p.name.slice(0, 160) : null;
    const [[u]] = await sequelize.query(
      `INSERT INTO users (global_eco_id, display_name, preferred_language, last_seen_at) VALUES (:s, :n, :l, now())
       ON CONFLICT (global_eco_id) DO UPDATE SET last_seen_at = now(), display_name = COALESCE(EXCLUDED.display_name, users.display_name)
       RETURNING id, status, (xmax = 0) AS created`, { replacements: { s: p.sub, n: name, l: language || 'en' } });
    // every person gets a personal organization; schedules are always owned by an organization (§6.1)
    if (u.created) await sequelize.query(`WITH o AS (INSERT INTO organizations (name, kind) VALUES (:n, 'personal') RETURNING id)
      INSERT INTO organization_members (organization_id, user_id, role) SELECT o.id, :u, 'owner' FROM o`, { replacements: { n: (name || 'Personal').slice(0, 120), u: u.id } });
    if (u.status !== 'active') throw forbidden('USER_DISABLED', 'Your EcoTime access is not active');
    await audit.log({ kind: 'person', id: u.id }, u.created ? 'user.created' : 'auth.signin', { req });
    return sessions.issue('person', u.id);
  }

  async function adminLogin({ email, password, code }, req) {
    const addr = String(email || '').trim().toLowerCase();
    const [[a]] = await sequelize.query(
      `SELECT id, password_hash AS "hash", totp_secret_enc AS "totp", totp_last_step AS "lastStep", failed_count AS "failed",
              locked_until AS "lockedUntil", (locked_until IS NOT NULL AND locked_until > now()) AS "isLocked", disabled_at AS "disabledAt"
         FROM admins WHERE email = :e`, { replacements: { e: addr } });
    const passOk = await verifyPassword(String(password || ''), a?.hash || DUMMY_HASH);
    const generic = () => unauthorized('ADMIN_LOGIN_FAILED', 'Email, password or code is not correct');
    if (!a || a.disabledAt) { await audit.log(null, 'admin.login_failed', { detail: { reason: 'unknown' }, req }); throw generic(); }
    if (a.isLocked) throw locked('ADMIN_LOCKED', 'Too many failed attempts. Try again later.', { retryAfter: a.lockedUntil });
    let step = null;
    if (passOk) {
      const secret = Buffer.from(open(cfg.dataKey, a.totp, `admin-totp:${a.id}`), 'base64url');
      step = verifyTotp(secret, code, { lastStep: Number(a.lastStep) });
    }
    if (!passOk || step === null) {
      await sequelize.query(
        `UPDATE admins SET failed_count = n, locked_until = CASE WHEN n >= :max THEN now() + make_interval(mins => :mins) ELSE NULL END
           FROM (SELECT CASE WHEN locked_until IS NOT NULL AND locked_until <= now() THEN 1 ELSE failed_count + 1 END AS n FROM admins WHERE id = :id) c
          WHERE id = :id`, { replacements: { id: a.id, max: cfg.admin.maxFailures, mins: cfg.admin.lockMinutes } });
      await audit.log({ kind: 'admin', id: a.id }, 'admin.login_failed', { detail: { reason: passOk ? 'code' : 'password' }, req });
      throw generic();
    }
    // The step update is conditional, so the same code cannot be replayed even by two requests at once.
    const [, meta] = await sequelize.query(
      `UPDATE admins SET totp_last_step = :s, failed_count = 0, locked_until = NULL, last_login_at = now() WHERE id = :id AND totp_last_step < :s`,
      { replacements: { s: step, id: a.id } });
    if (!(meta?.rowCount)) throw generic();
    await audit.log({ kind: 'admin', id: a.id }, 'admin.login', { req });
    return sessions.issue('admin', a.id);
  }

  return { exchangeEcoId, adminLogin };
}
