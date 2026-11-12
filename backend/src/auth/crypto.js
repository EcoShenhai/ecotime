// Password hashing (scrypt), encryption at rest (AES-256-GCM) and TOTP (RFC 6238 / RFC 4226).
import crypto from 'node:crypto';

// ---- passwords: scrypt N=2^15, r=8, p=1, 32-byte key; stored as scrypt$N$r$p$salt$hash
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32, maxmem: 96 * 1024 * 1024 };
const scryptAsync = (pw, salt, o) => new Promise((res, rej) => crypto.scrypt(pw, salt, o.keylen, { N: o.N, r: o.r, p: o.p, maxmem: o.maxmem }, (e, k) => (e ? rej(e) : res(k))));

export function passwordProblems(pw) {
  const p = [];
  if (typeof pw !== 'string' || pw.length < 12) p.push('at least 12 characters');
  if (typeof pw === 'string' && pw.length > 256) p.push('at most 256 characters');
  if (typeof pw === 'string' && new Set(pw).size < 6) p.push('more varied characters');
  return p;
}
export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(pw.normalize('NFKC'), salt, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}
export async function verifyPassword(pw, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt' || typeof pw !== 'string' || pw.length > 256) return false;
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64url');
  const got = await scryptAsync(pw.normalize('NFKC'), Buffer.from(salt, 'base64url'), { N: Number(N), r: Number(r), p: Number(p), keylen: expected.length, maxmem: SCRYPT.maxmem });
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}
// A fixed hash so unknown emails cost the same time as known ones.
export const DUMMY_HASH = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

// ---- encryption at rest: v1.<iv>.<ciphertext+tag>, AAD binds the value to its purpose and row
export function seal(key, plaintext, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv); c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final(), c.getAuthTag()]);
  return `v1.${iv.toString('base64url')}.${ct.toString('base64url')}`;
}
export function open(key, sealed, aad) {
  const [v, iv, data] = String(sealed).split('.');
  if (v !== 'v1' || !iv || !data) throw new Error('bad_envelope');
  const buf = Buffer.from(data, 'base64url');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url')); d.setAAD(Buffer.from(aad));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString('utf8');
}

// ---- TOTP: SHA-1, 6 digits, 30 s (what Shenhai Authenticator and every standard app use)
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s) {
  const clean = String(s).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) { const i = B32.indexOf(ch); if (i < 0) throw new Error('bad_base32'); value = (value << 5) | i; bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
export function hotp(secret, counter, digits = 6) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secret).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}
export const stepAt = (ms = Date.now(), period = 30) => Math.floor(ms / 1000 / period);
// Accepts the current step and one either side; returns the matched step so it can never be used twice.
export function verifyTotp(secret, code, { now = Date.now(), window = 1, lastStep = 0 } = {}) {
  if (!/^\d{6}$/.test(String(code || ''))) return null;
  const cur = stepAt(now);
  for (let d = -window; d <= window; d++) {
    const s = cur + d;
    if (s <= lastStep) continue;
    const exp = hotp(secret, s);
    if (crypto.timingSafeEqual(Buffer.from(exp), Buffer.from(String(code)))) return s;
  }
  return null;
}
export function otpauthUri({ secret, account, issuer = 'Shenhai EcoTime' }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${base32Encode(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
