import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { t, useI18n } from '../../i18n';
import { api, errText } from '../../lib/api';
import { session, type Pair } from '../../lib/session';
import { AUTHENTICATOR_URL } from '../../lib/config';
import { LanguagePicker } from '../Public';

// E12: the administrator signs in with email, password and a 6-digit code from Shenhai Authenticator.
// EcoID is never accepted here.
export function AdminLogin() {
  useI18n(); const nav = useNavigate();
  const [f, setF] = useState({ email: '', password: '', code: '' }); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  return <div className="lockwrap"><form className="panel stack" onSubmit={async (e) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { const p = await api<Pair>('POST', '/admin/auth/login', f, { auth: false }); await session.set(p); nav('/admin', { replace: true }); }
    catch (x) { setErr(errText(x)); setF((v) => ({ ...v, code: '' })); } finally { setBusy(false); }
  }}>
    <div className="row row--between"><span className="brand"><img src="/icon.svg" alt="" width="32" height="32" /> {t('app.name')}</span><LanguagePicker /></div>
    <h1>{t('adminLogin.title')}</h1>
    <p className="note">{t('adminLogin.text')}</p>
    <label>{t('adminLogin.email')}<input type="email" autoComplete="username" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
    <label>{t('adminLogin.password')}<input type="password" autoComplete="current-password" required value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></label>
    <label>{t('adminLogin.code')}<input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.replace(/\D/g, '').slice(0, 6) })} /></label>
    <p className="note">{t('adminLogin.codeHelp')} <a href={AUTHENTICATOR_URL} target="_blank" rel="noopener noreferrer">{t('adminLogin.openAuthenticator')}</a></p>
    {err ? <p className="error" role="alert">{err}</p> : null}
    <button className="btn" disabled={busy}>{t('adminLogin.signIn')}</button>
    <p className="note"><Link to="/">{t('adminLogin.notAdmin')}</Link></p>
  </form></div>;
}
