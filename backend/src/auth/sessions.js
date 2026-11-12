// App sessions: short HS256 access token + rotating refresh token stored as an HMAC (never in clear).
// Subjects are people (EcoID users) or the local administrator (password + TOTP, E12).
import crypto from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

const ISS = 'time.eshcloud.com';
const AUD = 'ecotime-api';

export function createSessions({ sequelize, cfg }) {
  const key = new TextEncoder().encode(cfg.jwtSecret);
  const hash = (t) => crypto.createHmac('sha256', cfg.refreshPepper).update(t).digest('hex');
  const ttl = (kind) => (kind === 'admin'
    ? { accessMin: cfg.session.adminAccessTtlMin, refresh: `make_interval(hours => ${Number(cfg.session.adminRefreshTtlHours)})` }
    : { accessMin: cfg.session.accessTtlMin, refresh: `make_interval(days => ${Number(cfg.session.refreshTtlDays)})` });

  async function signAccess(kind, subjectId, authTime) {
    return new SignJWT({ knd: kind, auth_time: Math.floor(new Date(authTime).getTime() / 1000) })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(subjectId).setIssuer(ISS).setAudience(AUD).setIssuedAt()
      .setExpirationTime(`${ttl(kind).accessMin}m`).setJti(crypto.randomUUID())
      .sign(key);
  }
  async function verifyAccess(token) {
    const { payload } = await jwtVerify(token, key, { issuer: ISS, audience: AUD, algorithms: ['HS256'] });
    if (payload.knd !== 'person' && payload.knd !== 'admin') throw new Error('bad_kind');
    return payload;
  }

  async function issue(kind, subjectId, authTime = new Date(), transaction) {
    const refreshToken = crypto.randomBytes(32).toString('base64url');
    await sequelize.query(
      `INSERT INTO auth_sessions (subject_kind, subject_id, token_hash, auth_time, expires_at)
       VALUES (:k, :s, :h, :at, now() + ${ttl(kind).refresh})`,
      { replacements: { k: kind, s: subjectId, h: hash(refreshToken), at: new Date(authTime) }, transaction });
    return { accessToken: await signAccess(kind, subjectId, authTime), refreshToken, tokenType: 'Bearer', expiresIn: ttl(kind).accessMin * 60, kind };
  }

  // The presented token is revoked in the statement that checks it. A token revoked more than 10 s ago
  // means reuse (likely theft): every session of that subject is revoked.
  async function rotate(refreshToken) {
    if (typeof refreshToken !== 'string' || refreshToken.length < 20 || refreshToken.length > 200) return { error: 'invalid' };
    const h = hash(refreshToken);
    return sequelize.transaction(async (t) => {
      const [rows] = await sequelize.query(
        `UPDATE auth_sessions s SET revoked_at = now()
          WHERE s.token_hash = :h AND s.revoked_at IS NULL AND s.expires_at > now()
            AND ((s.subject_kind = 'person' AND EXISTS (SELECT 1 FROM users p WHERE p.id = s.subject_id AND p.status = 'active'))
              OR (s.subject_kind = 'admin' AND EXISTS (SELECT 1 FROM admins a WHERE a.id = s.subject_id AND a.disabled_at IS NULL)))
        RETURNING s.subject_kind, s.subject_id, s.auth_time`, { replacements: { h }, transaction: t });
      if (rows.length === 1) return { pair: await issue(rows[0].subject_kind, rows[0].subject_id, rows[0].auth_time, t) };
      const [reused] = await sequelize.query(
        `SELECT subject_kind, subject_id, (revoked_at > now() - interval '10 seconds') AS recent FROM auth_sessions WHERE token_hash = :h AND revoked_at IS NOT NULL`,
        { replacements: { h }, transaction: t });
      if (reused.length && !reused[0].recent) {
        await sequelize.query(`UPDATE auth_sessions SET revoked_at = now() WHERE subject_kind = :k AND subject_id = :s AND revoked_at IS NULL`,
          { replacements: { k: reused[0].subject_kind, s: reused[0].subject_id }, transaction: t });
        return { error: 'reused', subjectKind: reused[0].subject_kind, subjectId: reused[0].subject_id };
      }
      return { error: 'invalid' };
    });
  }
  async function revoke(refreshToken) {
    if (typeof refreshToken !== 'string') return 0;
    const [, meta] = await sequelize.query(`UPDATE auth_sessions SET revoked_at = now() WHERE token_hash = :h AND revoked_at IS NULL`, { replacements: { h: hash(refreshToken) } });
    return meta?.rowCount ?? 0;
  }
  async function revokeAll(kind, subjectId) {
    await sequelize.query(`UPDATE auth_sessions SET revoked_at = now() WHERE subject_kind = :k AND subject_id = :s AND revoked_at IS NULL`, { replacements: { k: kind, s: subjectId } });
  }
  return { issue, rotate, revoke, revokeAll, verifyAccess };
}
