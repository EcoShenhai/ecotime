import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { t, useI18n, LANGUAGES, setLanguage, getLanguage } from '../i18n';
import { signIn, completeSignIn } from '../lib/ecoid';
import { errText, ApiError } from '../lib/api';

export function LanguagePicker() {
  useI18n();
  return <label className="langpick"><span className="sr-only">{t('settings.language')}</span>
    <select value={getLanguage()} onChange={(e) => { const v = e.target.value; localStorage.setItem('ecotime_lang', v); void setLanguage(v); }}>
      {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
    </select></label>;
}

export function Welcome({ returnTo = '/' }: { returnTo?: string }) {
  useI18n();
  return <div className="lockwrap"><div className="panel stack welcome">
    <div className="row row--between"><span className="brand"><img src="/icon.svg" alt="" width="36" height="36" /> {t('app.name')}</span><LanguagePicker /></div>
    <h1>{t('welcome.title')}</h1>
    <p>{t('welcome.text')}</p>
    <button className="btn btn--ecoid" onClick={() => { void signIn(returnTo); }}>{t('account.continueEcoid')}</button>
    <p className="note"><Link to="/admin/login">{t('welcome.admin')}</Link> · <Link to="/privacy">{t('nav.privacy')}</Link></p>
  </div></div>;
}

export function EcoIdCallback() {
  const nav = useNavigate(); const [err, setErr] = useState(''); const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return; ran.current = true;
    const p = new URLSearchParams(window.location.search); window.history.replaceState(null, '', '/auth/ecoid/callback');
    completeSignIn(p).then((to) => nav(to, { replace: true })).catch((e) => setErr(e instanceof ApiError ? errText(e) : e?.message === 'cancelled' ? t('ecoid.cancelled') : t('ecoid.failed')));
  }, [nav]);
  return <div className="lockwrap"><div className="panel stack">{err ? <><p className="error" role="alert">{err}</p><button className="btn" onClick={() => nav('/', { replace: true })}>{t('common.continue')}</button></> : <p role="status">{t('ecoid.completing')}</p>}</div></div>;
}

export function Privacy() {
  useI18n();
  const items = ['identity', 'schedules', 'clock', 'logs', 'thirdparty', 'retention', 'contact'];
  return <div className="shell"><main className="main stack narrow" id="main">
    <Link to="/">← {t('app.name')}</Link>
    <h1>{t('privacy.title')}</h1>
    {items.map((k) => <section key={k} className="stack-sm"><h2>{t(`privacy.${k}.title`)}</h2><p>{t(`privacy.${k}.text`)}</p></section>)}
  </main></div>;
}
