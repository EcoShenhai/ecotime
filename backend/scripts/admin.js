// System administrator (P11) on the server terminal only:
//   node scripts/admin.js create <email>        set a password, enrol Shenhai Authenticator, confirm with a code
//   node scripts/admin.js reset-totp <email>    enrol a new authenticator (old codes stop working)
//   node scripts/admin.js password <email>      set a new password (signs out every admin session)
//   node scripts/admin.js unlock <email>        clear a lockout
// The password is typed without echo and never stored or printed. The authenticator setup QR is drawn
// in this terminal once; clear the screen afterwards.
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { loadConfig } from '../src/config/env.js';
import { createSequelize } from '../src/db/index.js';
import { hashPassword, passwordProblems, seal, verifyTotp, otpauthUri, base32Encode, stepAt } from '../src/auth/crypto.js';

function ask(prompt, { hidden = false } = {}) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) return reject(new Error('run this in an interactive terminal'));
    stdout.write(prompt); let buf = '';
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const on = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', on); stdout.write('\n'); return resolve(buf); }
        if (c === '\u0003') { stdout.write('\n'); process.exit(130); }
        if (c === '\u007f' || c === '\b') { if (buf.length) { buf = buf.slice(0, -1); if (!hidden) stdout.write('\b \b'); } continue; }
        buf += c; if (!hidden) stdout.write(c);
      }
    };
    stdin.on('data', on);
  });
}

async function newPassword() {
  for (;;) {
    const a = await ask('New password (not shown): ', { hidden: true });
    const p = passwordProblems(a); if (p.length) { console.log(`Password needs ${p.join(', ')}.`); continue; }
    const b = await ask('Repeat password: ', { hidden: true });
    if (a !== b) { console.log('The two entries differ.'); continue; }
    return a;
  }
}

async function enrolTotp(email, adminId) {
  const secret = crypto.randomBytes(20);
  const uri = otpauthUri({ secret, account: email });
  console.log('\nIn Shenhai Authenticator (authenticator.eshcloud.com), choose Add account and scan this code:\n');
  console.log(await QRCode.toString(uri, { type: 'terminal', small: true, errorCorrectionLevel: 'M' }));
  console.log(`Or enter this setup key by hand: ${base32Encode(secret).replace(/(.{4})/g, '$1 ').trim()}\n`);
  for (let i = 0; i < 3; i++) {
    const code = (await ask('Enter the 6-digit code the authenticator now shows: ')).trim();
    const step = verifyTotp(secret, code);
    if (step !== null) return { sealed: (cfg) => seal(cfg.dataKey, secret.toString('base64url'), `admin-totp:${adminId}`), step };
    console.log('That code does not match. Check the phone clock is set automatically and try the next code.');
  }
  throw new Error('authenticator not confirmed; nothing was changed');
}

const [cmd, emailArg] = process.argv.slice(2);
const email = String(emailArg || '').trim().toLowerCase();
if (!['create', 'reset-totp', 'password', 'unlock'].includes(cmd) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error('usage: node scripts/admin.js create|reset-totp|password|unlock <email>'); process.exit(2);
}
const cfg = loadConfig(); const sequelize = createSequelize(cfg);
const q = (sql, r) => sequelize.query(sql, { replacements: r }).then(([rows]) => rows);
try {
  const [existing] = await q(`SELECT id FROM admins WHERE email = :e`, { e: email });
  if (cmd === 'create') {
    if (existing) throw new Error('that administrator already exists (use password or reset-totp)');
    const id = crypto.randomUUID();
    const hash = await hashPassword(await newPassword());
    const t = await enrolTotp(email, id);
    await q(`INSERT INTO admins (id, email, password_hash, totp_secret_enc, totp_last_step) VALUES (:id, :e, :h, :s, :st)`, { id, e: email, h: hash, s: t.sealed(cfg), st: t.step });
    await q(`INSERT INTO audit_events (actor_kind, actor_id, action, subject_kind, subject_id) VALUES ('system', NULL, 'admin.created', 'admin', :id)`, { id });
    console.log(`\nAdministrator ${email} created. Sign in at ${cfg.publicBaseUrl}/admin/login with the email, the password and a fresh code.`);
  } else {
    if (!existing) throw new Error('no administrator with that email');
    if (cmd === 'reset-totp') {
      const t = await enrolTotp(email, existing.id);
      await q(`UPDATE admins SET totp_secret_enc = :s, totp_last_step = :st WHERE id = :id`, { s: t.sealed(cfg), st: t.step, id: existing.id });
    } else if (cmd === 'password') {
      await q(`UPDATE admins SET password_hash = :h, password_changed_at = now() WHERE id = :id`, { h: await hashPassword(await newPassword()), id: existing.id });
    } else {
      await q(`UPDATE admins SET failed_count = 0, locked_until = NULL WHERE id = :id`, { id: existing.id });
    }
    await q(`UPDATE auth_sessions SET revoked_at = now() WHERE subject_kind = 'admin' AND subject_id = :id AND revoked_at IS NULL AND :c <> 'unlock'`, { id: existing.id, c: cmd });
    await q(`INSERT INTO audit_events (actor_kind, actor_id, action, subject_kind, subject_id) VALUES ('system', NULL, :a, 'admin', :id)`, { a: `admin.${cmd}`, id: existing.id });
    console.log(`Done: ${cmd} for ${email}.`);
  }
  void stepAt;
} catch (e) { console.error(`Stopped: ${e.message}`); process.exitCode = 1; } finally { await sequelize.close(); }
