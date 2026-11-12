// EcoID token verification (ES256 against EcoID JWKS; issuer and audience = B2X Manager client ids).
// Used once per sign-in: the verified EcoID subject is exchanged for a B2X Manager session.
// P11: tokens claiming administrator rights are refused. P7: the identity key is the EcoID subject, never email.
import { createRemoteJWKSet, jwtVerify } from 'jose';


const ADMIN_ROLE = /^(super_?admin|superadmin|admin|technical_admin|business_admin|platform_admin)$/i;

export function createEcoId({ issuer, audiences, allowNoAudience = false, jwks, fetchImpl = fetch }) {
  const keySet = jwks || createRemoteJWKSet(new URL(`${issuer}/api/v1/oidc/jwks`), { cooldownDuration: 30000, timeoutDuration: 8000 });
  async function verify(token) {
    if (!token || typeof token !== 'string' || token.length > 8192) throw new Error('missing_token');
    const { payload } = await jwtVerify(token, keySet, { issuer, algorithms: ['ES256'], clockTolerance: 30 });
    if (payload.aud === undefined) { if (!allowNoAudience) throw new Error('missing_audience'); }
    else if (!(Array.isArray(payload.aud) ? payload.aud : [payload.aud]).some((a) => audiences.includes(a))) throw new Error('wrong_audience');
    if (!payload.sub || typeof payload.sub !== 'string' || payload.sub.length > 255) throw new Error('missing_subject');
    return payload;
  }
  function claimsAdmin(p) {
    const found = []; const collect = (v) => { if (!v) return; if (typeof v === 'string') found.push(v); else if (Array.isArray(v)) v.forEach(collect); else if (typeof v === 'object') Object.values(v).forEach(collect); };
    collect(p.role); collect(p.roles); collect(p.app_roles); collect(p.realm_access?.roles);
    return p.is_admin === true || p.is_super_admin === true || found.some((r) => ADMIN_ROLE.test(String(r)));
  }
  async function userinfo(token) {
    const r = await fetchImpl(`${issuer}/api/v1/oidc/userinfo`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`userinfo_${r.status}`);
    return (await r.json()) || {};
  }
  return { verify, claimsAdmin, userinfo };
}
